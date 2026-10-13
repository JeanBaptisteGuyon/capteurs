/*
 * Service worker du tableau de bord des capteurs.
 *
 * Deux stratégies distinctes, et la distinction est le coeur du fichier :
 *
 *   - La coquille (page, manifeste, icônes) est servie depuis le cache puis
 *     rafraîchie en arrière-plan. L'application s'ouvre donc instantanément
 *     et fonctionne hors réseau ; une modification du dépôt apparaît au
 *     lancement suivant.
 *
 *   - Les mesures passent d'abord par le réseau, et ne retombent sur le cache
 *     qu'en cas d'échec. Il serait inacceptable d'afficher des températures
 *     périmées comme si elles étaient actuelles : la page signale déjà l'âge
 *     de chaque relevé, encore faut-il qu'on lui donne les vraies.
 *
 * Incrémente VERSION après toute modification de ce fichier : c'est ce qui
 * déclenche la purge des anciens caches.
 */

const VERSION = "capteurs-v1";
const CACHE_COQUILLE = VERSION + "-coquille";
const CACHE_DONNEES  = VERSION + "-donnees";

const COQUILLE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icone-192.png",
  "./icone-512.png",
  "./icone-masquable-512.png"
];

// Nombre maximal de fichiers de mesures conservés hors ligne. Au-delà, les
// plus anciens sont écartés : un cache sans limite finirait par saturer
// le quota du navigateur et provoquerait des échecs d'écriture silencieux.
const MAX_DONNEES = 400;

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches.open(CACHE_COQUILLE)
      // addAll échoue en bloc si un seul fichier manque : on tolère les
      // absences pour qu'une icône oubliée n'empêche pas l'installation.
      .then((c) => Promise.allSettled(COQUILLE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (evt) => {
  evt.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => !n.startsWith(VERSION))
            .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

async function limiterCache(nom, maximum) {
  const cache = await caches.open(nom);
  const cles = await cache.keys();
  for (let i = 0; i < cles.length - maximum; i++) {
    await cache.delete(cles[i]);
  }
}

// Réseau d'abord : on n'affiche d'anciennes mesures que si le réseau échoue.
async function reseauPuisCache(requete) {
  const cache = await caches.open(CACHE_DONNEES);
  try {
    const reponse = await fetch(requete);
    if (reponse && reponse.ok) {
      cache.put(requete, reponse.clone());
      limiterCache(CACHE_DONNEES, MAX_DONNEES);
    }
    return reponse;
  } catch (e) {
    const garde = await cache.match(requete);
    if (garde) return garde;
    // Une journée sans relevé est un cas normal, pas une panne : on répond
    // 404 comme le ferait le serveur, et la page l'absorbe silencieusement.
    return new Response("", { status: 404, statusText: "hors ligne" });
  }
}

// Cache d'abord, puis mise à jour en arrière-plan pour le lancement suivant.
async function cachePuisReseau(requete) {
  const cache = await caches.open(CACHE_COQUILLE);
  const garde = await cache.match(requete, { ignoreSearch: true });

  const reseau = fetch(requete).then((reponse) => {
    if (reponse && reponse.ok) cache.put(requete, reponse.clone());
    return reponse;
  }).catch(() => null);

  return garde || (await reseau) || Response.error();
}

self.addEventListener("fetch", (evt) => {
  const requete = evt.request;
  if (requete.method !== "GET") return;

  const url = new URL(requete.url);
  // Ne jamais intercepter ce qui vient d'un autre domaine.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes("/donnees/")) {
    evt.respondWith(reseauPuisCache(requete));
    return;
  }

  // Une navigation hors ligne doit aboutir à la page, pas à l'erreur du
  // navigateur : d'où le repli explicite sur index.html.
  if (requete.mode === "navigate") {
    evt.respondWith(
      cachePuisReseau(requete).catch(() => caches.match("./index.html"))
    );
    return;
  }

  evt.respondWith(cachePuisReseau(requete));
});
