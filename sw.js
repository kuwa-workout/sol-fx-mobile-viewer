/* Cache only our published static shell, NEVER API requests, tokens or observations. */
const CACHE = 'sol-fx-mobile-shell-v2-0-1';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('sol-fx-mobile-shell-')&&key!==CACHE).map(key=>caches.delete(key)))));});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return; // Never intercept / cache GitHub API
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(()=>caches.match('./index.html')));
    return;
  }
  if(!ASSETS.some(p=>new URL(p,self.registration.scope).href===url.href))return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
