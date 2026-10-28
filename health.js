/* SOL FX LAB v2.1: pure, read-only health classifier. No network and no secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.SolHealth = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const MIN = 60_000;
  const threshold = (age, warn, bad) => age > bad ? 'bad' : age > warn ? 'warn' : 'ok';
  const entry = (key, label, value, note, level) => ({key,label,value,note,level});
  const age = (now, time) => Number.isFinite(time) && time > 0 ? Math.max(0, (now - time) / MIN) : null;
  const shortAge = minutes => minutes === null ? '—' : (minutes < 1 ? '<1分' : (minutes < 60 ? Math.floor(minutes)+'分' : (Math.floor(minutes/60)+'時間'+Math.floor(minutes%60)+'分')));
  function classify({now, loadedAt, publishedAt, runAt, candleAt, expectedAt, trading, source, syncError=false}) {
    const market = trading === true;
    const metrics = [];
    if (!Number.isFinite(now)) throw Error('now is required');
    const localAge = age(now, loadedAt);
    metrics.push(localAge === null
      ? entry('load','iPhone取得','未取得','再取得するまで監視状態は判定できません','unknown')
      : entry('load','iPhone取得',shortAge(localAge)+'前',syncError?'前回の取得データを表示しています': '最後にデータ取得が成功した時刻',syncError?'bad':threshold(localAge,10,30)));
    const pubAge = age(now, publishedAt);
    metrics.push(source !== 'encrypted'
      ? entry('publish','公開用データ生成','対象外','手動・PAT取込では公開時刻を取得しません','unknown')
      : pubAge === null
        ? entry('publish','公開用データ生成','時刻未記録','旧形式の暗号文。次回の新しい暗号文で判定できます','unknown')
        : publishedAt > now+5*MIN
          ? entry('publish','公開用データ生成','時刻が未来','端末時刻またはクラウド時計を確認','bad')
          : entry('publish','公開用データ生成',shortAge(pubAge)+'前',market?'暗号化データ生成時刻（実際の公開完了時刻ではありません）':'参考市場の休場時間帯',market?threshold(pubAge,90,150):'off'));
    const runAge=age(now,runAt);
    const runInFuture = Number.isFinite(runAt) && runAt > now+5*MIN;
    metrics.push(runInFuture
      ? entry('run','クラウド監視','時刻が未来','端末時刻・クラウド時計を確認','bad')
      : runAge === null
      ? entry('run','クラウド監視','実行不明','実行履歴がないため判定できません','unknown')
      : entry('run','クラウド監視',shortAge(runAge)+'前',market?'監視プログラムの最終実行':'参考市場の休場時間帯',market?threshold(runAge,90,150):'off'));
    const due=Number.isFinite(expectedAt)?(now-(expectedAt+60*MIN))/MIN:null;
    const lag=Number.isFinite(candleAt)&&Number.isFinite(expectedAt) ? Math.round((expectedAt-candleAt)/(60*MIN)) : null;
    metrics.push(!Number.isFinite(candleAt)||!Number.isFinite(expectedAt)
      ? entry('candle','確定足観測','不明','確定足の日時を確認できません','unknown')
      : !market
        ? entry('candle','確定足観測','休場中','参考市場の休場時間帯。新しい確定足は期待しません','off')
        : candleAt>=expectedAt
          ? entry('candle','確定足観測','直近観測済み','想定した最新の確定足まで確認','ok')
          : due!==null && due<=20
            ? entry('candle','確定足観測','観測待ち','足確定後20分以内の猶予時間','warn')
            : entry('candle','確定足観測',Math.max(1,lag)+'本不足','市場稼働時間の欠損本数ではなく単純な経過足数です',due!==null&&due>80?'bad':'warn'));
    const levels=metrics.map(m=>m.level);
    const unknownCritical=metrics.some(m=>m.level==='unknown'&&(m.key==='run'||m.key==='candle'||(m.key==='publish'&&source==='encrypted')));
    const overall=levels.includes('bad')?'bad':levels.includes('warn')?'warn':unknownCritical?'partial':levels.every(v=>v==='off'||v==='unknown')?'unknown':'ok';
    const labels={ok:'取得・監視状況：概ね正常',warn:'注意：更新待ち・遅延の可能性',bad:'要確認：取得失敗・監視遅延',unknown:'情報不足：判定保留',partial:'一部未確認：監視品質を確認できません'};
    return {metrics,overall,headline:!market&&overall==='ok'?'休場中：iPhone取得のみ確認':labels[overall]};
  }
  return Object.freeze({classify});
});
