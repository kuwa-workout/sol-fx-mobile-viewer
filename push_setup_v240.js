(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const status = message => { $('status').textContent = message; };
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = location.protocol === 'https:' && 'serviceWorker' in navigator &&
    'PushManager' in window && 'Notification' in window && 'crypto' in window;
  $('capability').textContent = !supported ?
    '❌ この環境はWeb Pushに対応してへん。iOS 16.4以降を確認してな。' :
    standalone ? '✅ ホーム画面アプリとして起動中。通知登録の準備OK。' :
      '⚠️ Safariのページではなく、ホーム画面に追加したSOL FX LABアイコンから開いてな。';

  function base64UrlToArray(input) {
    if (!/^[A-Za-z0-9_-]{80,120}$/.test(input)) throw new Error('公開鍵の形式が不正です');
    const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    const bytes = Uint8Array.from(raw, x => x.charCodeAt(0));
    if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('P-256公開鍵ではありません');
    return bytes;
  }
  $('subscribe').addEventListener('click', async () => {
    if (!supported) return status('❌ このブラウザでは登録できへん。');
    if (!standalone) return status('⚠️ iPhoneのホーム画面に追加したSOL FX LABから開いてな。');
    let key;
    try { key = base64UrlToArray($('publicKey').value.trim()); }
    catch (error) { return status('❌ ' + error.message); }
    $('subscribe').disabled = true;
    try {
      // Permission request is directly initiated from this button's user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知の許可が得られませんでした（iPhone設定を確認）');
      await navigator.serviceWorker.register('./sw.js');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const old = subscription.options?.applicationServerKey;
        const oldBytes = old ? new Uint8Array(old) : null;
        if (!oldBytes || oldBytes.length !== key.length || oldBytes.some((b, i) => b !== key[i])) {
          throw new Error('以前と異なる公開鍵で登録済みです。解除・再登録の操作が必要です。');
        }
      } else {
        subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
      }
      const json = subscription.toJSON();
      if (!json || typeof json.endpoint !== 'string' || !json.keys?.p256dh || !json.keys?.auth) throw Error('通知の宛先情報が不完全です');
      $('subscription').value = JSON.stringify(json);
      $('output').hidden = false;
      status('✅ 端末の通知登録が完了。登録情報を非公開GitHub Secretsに保存してな。まだテスト通知は送ってへんで。');
    } catch (error) { status('❌ ' + (error instanceof Error ? error.message : '登録失敗')); }
    finally { $('subscribe').disabled = false; }
  });
  $('copy').addEventListener('click', async () => {
    const value = $('subscription').value;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); status('✅ コピーしたで。GitHubの非公開Secretsへ貼り付けてな。'); }
    catch (_) { $('subscription').focus(); $('subscription').select(); status('コピーが使えへん場合は、選択された文字列を手動コピーしてな。'); }
  });
})();
