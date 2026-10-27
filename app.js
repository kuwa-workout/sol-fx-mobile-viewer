/* SOL FX LAB v2.0 / Mobile read-only viewer.
 * Only same-origin static assets and api.github.com are used. API credentials
 * exist in memory, never localStorage, IndexedDB, a cookie or Service Worker.
 * No order, market execution, Web Push, or notification functionality.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const MAX_FILE = 1_000_000; // GitHub REST contents API small-file mode
  const JST_MS = 9 * 3600_000;
  const session = { obs:null, runs:null, token:null, repo:null, checked:0, busy:false, epoch:0, duplicates:0, error:false, manualObs:null, manualRuns:null, source:null };
  const fmtNY = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', weekday:'short', hour:'2-digit', hourCycle:'h23' });
  const clip = (x, d=3) => (typeof x === 'number' && Number.isFinite(x)) ? x.toFixed(d) : '—';
  const txt = (id, value) => { $(id).textContent = value == null ? '—' : String(value); };
  const jstTime = ms => Number.isFinite(ms) ? new Date(ms+JST_MS).toISOString().slice(0,16).replace('T',' ') : '—';
  const parseJst = text => {
    if(typeof text !== 'string') return NaN;
    const m=text.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
    if(m){
      const year=+m[1],month=+m[2],day=+m[3],hour=+m[4],min=+m[5];
      const ms=Date.UTC(year,month-1,day,hour,min)-JST_MS;
      const check=new Date(ms+JST_MS);
      if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day||check.getUTCHours()!==hour||check.getUTCMinutes()!==min)return NaN;
      return ms;
    }
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text))return NaN;
    return Date.parse(text);
  };
  const refSession = ms => {
    const p=Object.fromEntries(fmtNY.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
    const h=Number(p.hour),d=p.weekday;
    return (d==='Sun'&&h>=18)||(d==='Mon'||d==='Tue'||d==='Wed'||d==='Thu')||(d==='Fri'&&h<17);
  };
  const latestExpectedSlot = now => {
    let slot=Math.floor(now/3600_000)*3600_000-3600_000;
    for(let i=0;i<180;i++,slot-=3600_000){if(refSession(slot))return slot;}
    return null;
  };
  const countMissingTradingSlots = (after, until) => {
    let count=0;for(let at=after+3600_000;at<=until && count<500;at+=3600_000){if(refSession(at))count++;}
    return count;
  };
  function parseJsonl(raw,kind){
    if(new TextEncoder().encode(raw).length>MAX_FILE)throw Error(kind+'が1MBを超えています。GitHub Contents APIでの取得は対象外です。');
    const items=[];
    for(const [i,line] of raw.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
      if(!line.trim())continue;
      let row;try{row=JSON.parse(line);}catch(_){throw Error(kind+'の'+(i+1)+'行目にJSONの不備があります');}
      if(!row||typeof row!=='object'||Array.isArray(row))throw Error(kind+'の'+(i+1)+'行目がオブジェクトではありません');
      if(!['1.9.1','1.9.3'].includes(row.quality_version))throw Error(kind+'に未対応の品質バージョンがあります');
      items.push(row);
    }
    return items;
  }
  function validateObs(rows){
    const unique=new Map();let duplicates=0;
    for(const row of rows){
      if(row.quality_status!=='SESSION_VALIDATED'||!['BUY','SELL','WAIT'].includes(row.signal))throw Error('観測履歴の品質または売買判定が不正です');
      const at=parseJst(row.candle_start_jst),observed=parseJst(row.observed_at_jst);
      if(!Number.isFinite(at)||!Number.isFinite(observed)||observed<at+3600_000)throw Error('観測履歴の日時が不正です');
      for(const key of ['close','ema20','ema50','rsi14','atr14','ema_diff_atr']){
        if(row[key]==null||row[key]===''||!Number.isFinite(Number(row[key])))throw Error('指標 '+key+' が不正です');
      }
      if(row.missing_prior_observations!=null && (!Number.isSafeInteger(Number(row.missing_prior_observations))||Number(row.missing_prior_observations)<0))throw Error('欠損数が不正です');
      if(unique.has(row.candle_start_jst)){
        if(JSON.stringify(unique.get(row.candle_start_jst))!==JSON.stringify(row))throw Error('同一確定足に異なる観測があります');
        duplicates++;continue;
      }
      unique.set(row.candle_start_jst,row);
    }
    return {rows:[...unique.values()].sort((a,b)=>parseJst(b.candle_start_jst)-parseJst(a.candle_start_jst)),duplicates};
  }
  function validateRuns(rows){
    for(const row of rows){
      if(!Number.isFinite(parseJst(row.checked_at_jst))||!Number.isFinite(parseJst(row.target_candle_jst))||typeof row.status!=='string'||row.status.length>90)throw Error('実行履歴の日時または状態が不正です');
    }
    return [...rows].sort((a,b)=>parseJst(b.checked_at_jst)-parseJst(a.checked_at_jst));
  }
  function setStatus(message,bad=false){const el=$('message');el.textContent=message;el.classList.toggle('bad',bad);}
  function chip(text,mode){const el=$('connectionChip');el.textContent=text;el.className='chip '+mode;}
  function isCurrentlyEligible(o, now, expected){
    return Boolean(o && ['BUY','SELL'].includes(o.signal) && o.eligible_for_prompt_alert === true && Number(o.missing_prior_observations)===0
      && !o.late_over_20_min && Number(o.delay_from_close_min)<=20 && parseJst(o.candle_start_jst)===expected
      && now>=(expected+3600_000) && now-(expected+3600_000)<=20*60_000 && refSession(expected));
  }
  function renderFreshness(){
    const fresh=$('freshness');const now=Date.now(),latest=session.obs?.[0],runs=session.runs;
    if(!latest){fresh.className='freshness empty';txt('freshnessTitle','データ未読込');txt('freshnessText','GitHubへ接続するか、検証済みJSONLを読み込んでください。');txt('alertEligibility','速報適格性：未判定');return;}
    const expected=latestExpectedSlot(now),at=parseJst(latest.candle_start_jst),currentSlot=Math.floor(now/3600_000)*3600_000-3600_000;
    const isTradingHour=refSession(currentSlot),dueMin=(now-(expected+3600_000))/60_000;
    const lastRun=runs?.[0];const runAt=lastRun?parseJst(lastRun.checked_at_jst):NaN;
    let title='観測データを確認',note='';let mode='ok';
    if(!isTradingHour){title='参考市場は休場時間帯';note='週末休場中は新しい足が増えません。最終実行の状況も確認してください。';mode='warn';}
    else if(at>=expected){title='直近の確定足を観測済み';note='観測時刻と閲覧時点の鮮度は別です。最新記録を確認してください。';}
    else if(dueMin<=20){title='新しい確定足の観測待ち';note='対象足が確定してから約'+Math.max(0,Math.floor(dueMin))+'分。監視の猶予時間内です。';mode='warn';}
    else{title='監視データが遅延';note='直近想定足まで市場稼働時間に'+countMissingTradingSlots(at,expected)+'本分の差があります。クラウドの履歴を確認してください。';mode='bad';}
    if(!Number.isFinite(runAt)||now-runAt>125*60_000){note+=' 最終実行記録も古い／不明です。';if(mode==='ok')mode='warn';}
    if(session.error){mode='bad';title='同期失敗・前回データを表示中';note='現在のGitHubとの接続は確認できません。 '+note;}
    fresh.className='freshness '+mode;txt('freshnessTitle',title);txt('freshnessText',note);
    txt('alertEligibility',isCurrentlyEligible(latest,now,expected)&&!session.error?'速報条件内（通知機能は未実装）':'速報対象外');
  }
  function recordCard(row,kind){
    const el=document.createElement('article');el.className='history-item';
    const line=document.createElement('div');line.className='history-line';
    const time=document.createElement('time');
    const badge=document.createElement('span');badge.className='signal-badge';
    const extra=document.createElement('p');extra.className='row-extra';
    const note=document.createElement('p');note.className='row-note';
    if(kind==='obs'){
      time.textContent=row.candle_start_jst+' JST';badge.textContent=row.signal;badge.classList.add(row.signal.toLowerCase());
      extra.textContent='終値 '+clip(Number(row.close))+' ｜ RSI '+clip(Number(row.rsi14),1)+' ｜ 遅延 '+clip(Number(row.delay_from_close_min),1)+'分';
      note.textContent='品質 '+row.quality_status+' ｜ 欠損 '+(Number(row.missing_prior_observations)||0)+'本';
    }else{
      time.textContent=jstTime(parseJst(row.checked_at_jst));badge.textContent=row.status.slice(0,32);
      extra.textContent='対象足 '+row.target_candle_jst+' ｜ '+(row.signal?'判定 '+row.signal:'判定なし');
      note.textContent=(typeof row.note==='string'?row.note.slice(0,200):'')||'記録済み';
    }
    line.append(time,badge);el.append(line,extra,note);return el;
  }
  function drawHistory(){
    const draw=(id,rows,kind)=>{const parent=$(id);parent.replaceChildren();
      if(!rows||rows.length===0){const empty=document.createElement('div');empty.className='empty-history';empty.textContent='表示できる'+(kind==='obs'?'観測':'実行')+'履歴がありません';parent.append(empty);return;}
      for(const row of rows.slice(0,kind==='obs'?50:30))parent.append(recordCard(row,kind));
    };
    draw('panelObs',session.obs,'obs');draw('panelRuns',session.runs,'runs');
  }
  function render(){
    const latest=session.obs?.[0],run=session.runs?.[0];
    chip(session.encryptedPassphrase?'暗号化同期中':session.token?'GitHub接続中':session.obs?(session.source==='github'?'前回取得（切断）':'手動データ'):'未接続',session.token?'ok':session.obs?'warn':'offline');
    const hero=$('heroSignal');hero.textContent=latest?.signal??'—';hero.className='hero-signal '+(latest?.signal.toLowerCase()??'');
    txt('heroCandle',latest?.candle_start_jst??'—');txt('heroClose',latest?'終値 '+clip(Number(latest.close))+' 円':'終値 —');
    txt('lastObserved',latest?jstTime(parseJst(latest.observed_at_jst)):'—');txt('lastStatus',run?.status??'—');
    txt('lastRunTime',run?jstTime(parseJst(run.checked_at_jst)):'実行記録なし');
    txt('obsCount',session.obs?session.obs.length+'件':'—');txt('dupCount',session.obs?'重複 '+session.duplicates+'件（非表示）':'重複 —');
    txt('barDelay',latest?clip(Number(latest.delay_from_close_min),1)+'分':'—');txt('delayCaption',latest&&Number(latest.delay_from_close_min)>20?'⚠️ 確定後20分超':'確定から観測まで');
    for(const key of ['ema20','ema50','rsi14','atr14'])txt(key,latest?clip(Number(latest[key]),key==='rsi14'?1:3):'—');
    txt('strength',latest?clip(Number(latest.ema_diff_atr),3):'—');txt('filter',latest?(latest.filter_025?'通過':'対象外'):'—');
    txt('techQuality',latest?latest.quality_status:'—');
    txt('tradeRefs',latest?'参考 ENTRY '+(latest.entry_ref==null?'—':clip(Number(latest.entry_ref)))+' / SL '+(latest.sl==null?'—':clip(Number(latest.sl)))+' / TP '+(latest.tp==null?'—':clip(Number(latest.tp))):'参考 ENTRY — / SL — / TP —');
    txt('loadedAt',session.checked?'最終読込 '+jstTime(session.checked):'最終読込 —');
    drawHistory();renderFreshness();
  }
  function controls(){
    $('connectBtn').disabled=session.busy;
    $('refreshBtn').disabled=session.busy||!session.token;
    $('disconnectBtn').disabled=!session.token&&!session.busy;
  }
  function validRepo(text){return typeof text==='string' && /^[A-Za-z0-9_.-]{1,100}$/.test(text) && text!=='.' && text!=='..';}
  function fileUrl(path,owner,repo){return 'https://api.github.com/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo)+'/contents/'+path+'?ref=main';}
  async function fetchJsonl(path,token,owner,repo){
    const response=await fetch(fileUrl(path,owner,repo),{headers:{'Accept':'application/vnd.github+json','Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},cache:'no-store',redirect:'error'});
    if(!response.ok)throw Error('GitHub API '+response.status+'：権限・トークン期限・ファイルパスを確認');
    const data=await response.json();
    if(data.type!=='file'||data.encoding!=='base64'||typeof data.content!=='string'||data.size>MAX_FILE)throw Error('GitHubのファイル形式が未対応（1MBを超える場合も不可）');
    const raw=atob(data.content.replace(/\s+/g,''));
    const bytes=Uint8Array.from(raw,ch=>ch.charCodeAt(0));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  async function sync(token,repo){
    if(session.busy)return;
    const epoch=++session.epoch;
    session.busy=true;controls();setStatus('⏳ GitHubから観測・実行データを取得しています…');
    try{
      const [rawObs,rawRuns]=await Promise.all([
        fetchJsonl('data/observations_verified.jsonl',token,repo.owner,repo.name),
        fetchJsonl('data/runs_verified.jsonl',token,repo.owner,repo.name)]);
      const {rows,duplicates}=validateObs(parseJsonl(rawObs,'観測履歴'));
      const runs=validateRuns(parseJsonl(rawRuns,'実行履歴'));
      if(epoch!==session.epoch)return;
      session.obs=rows;session.runs=runs;session.duplicates=duplicates;session.token=token;session.repo=repo;session.checked=Date.now();session.error=false;session.source='github';
      setStatus('✅ GitHub APIで読込：観測 '+rows.length+'件 ／ 実行 '+runs.length+'件'+(duplicates?' ／ 重複'+duplicates+'件':'')+'。実注文・通知はありません。');
      render();
    }catch(err){
      if(epoch!==session.epoch)return;
      session.error=true;
      const m=err instanceof Error?err.message:'取得できませんでした';
      setStatus('❌ '+m+'。前回取得済みデータがあればそのまま表示します。',true);
      if(/API 401|API 403/.test(m))session.token=null;
      renderFreshness();
    }finally{session.busy=false;controls();}
  }
  $('connectBtn').addEventListener('click',()=>{
    const token=$('githubToken').value.trim();$('githubToken').value='';
    const owner=$('repoOwner').value.trim(),name=$('repoName').value.trim();
    if(!validRepo(owner)||!validRepo(name)){setStatus('オーナー名・リポジトリ名が正しくありません。',true);return;}
    if(!token){setStatus('一時的な読み取り専用GitHub PATを入力してください。',true);return;}
    session.manualObs=null;session.manualRuns=null;session.encryptedPassphrase=null;
    void sync(token,{owner,name});
  });
  $('refreshBtn').addEventListener('click',()=>{if(session.token&&session.repo)void sync(session.token,session.repo);});
  $('disconnectBtn').addEventListener('click',()=>{
    session.epoch++;session.token=null;session.repo=null;session.error=false;
    $('githubToken').value='';$('autoRefresh').checked=false;
    setStatus('🔒 接続を切断しトークンを破棄しました。読み込んだデータは画面を閉じるまで表示されます。');
    controls();render();
  });
  async function loadManual(kind,file){
    if(!file)return;
    try{
      if(file.size>MAX_FILE)throw Error('ファイルサイズが1MBを超えています');
      const raw=await file.text();
      if(kind==='obs'){const {rows,duplicates}=validateObs(parseJsonl(raw,'観測履歴'));session.manualObs={rows,duplicates};}
      else session.manualRuns=validateRuns(parseJsonl(raw,'実行履歴'));
      const parts=[session.manualObs?'観測✓':'観測未選択',session.manualRuns?'実行✓':'実行未選択'];
      txt('manualState',parts.join('／'));
      if(session.manualObs&&session.manualRuns){
        session.epoch++;session.token=null;session.repo=null;session.encryptedPassphrase=null;session.error=false;$('githubToken').value='';$('autoRefresh').checked=false;
        session.obs=session.manualObs.rows;session.runs=session.manualRuns;session.duplicates=session.manualObs.duplicates;session.checked=Date.now();session.source='manual';
        controls();render();setStatus('✅ 手動取込：観測 '+session.obs.length+'件 ／ 実行 '+session.runs.length+'件。認証情報は不要です。');
      }
    }catch(err){setStatus('❌ ファイル取込失敗：'+(err instanceof Error?err.message:'形式不正'),true);}
  }
  for(const [id,kind] of [['obsFile','obs'],['runsFile','runs']]){
    $(id).addEventListener('change',e=>{const file=e.currentTarget.files?.[0];void loadManual(kind,file);e.currentTarget.value='';});
  }
  function setTab(selected){
    const obs=selected==='obs';
    $('panelObs').hidden=!obs;$('panelRuns').hidden=obs;
    $('tabObs').classList.toggle('selected',obs);$('tabRuns').classList.toggle('selected',!obs);
    $('tabObs').setAttribute('aria-selected',String(obs));$('tabRuns').setAttribute('aria-selected',String(!obs));
  }
  $('tabObs').addEventListener('click',()=>setTab('obs'));
  $('tabRuns').addEventListener('click',()=>setTab('runs'));
  const maybeSync=()=>{
    renderFreshness();
    if(!document.hidden&&$('autoRefresh').checked&&session.token&&session.repo&&!session.busy&&Date.now()-session.checked>=300_000)void sync(session.token,session.repo);
  };
  setInterval(maybeSync,30_000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)maybeSync();});
  window.addEventListener('pagehide',()=>{session.epoch++;session.token=null;session.repo=null;session.encryptedPassphrase=null;$('githubToken').value='';$('autoRefresh').checked=false;});
  window.addEventListener('pageshow',()=>{controls();render();});
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{/* PWA shell unavailable, app still works */}));
  }
  // v2.0.1: Public ciphertext / private passphrase. Never cache decrypted data or secrets.
  const secureUrl='./secure_snapshot.json';
  const secureAAD=new TextEncoder().encode('SOL-FX-LAB-SECURE-SNAPSHOT-v1');
  const decodeB64 = s => Uint8Array.from(atob(s),x=>x.charCodeAt(0));
  async function decryptSnapshot(envelope,passphrase){
    if(envelope.version!==1||envelope.kdf!=='PBKDF2-SHA256'||envelope.cipher!=='AES-256-GCM'||envelope.iterations!==600000)
      throw Error('未対応の暗号化データ形式');
    const salt=decodeB64(envelope.salt),nonce=decodeB64(envelope.nonce),cipher=decodeB64(envelope.ciphertext);
    if(salt.length!==16||nonce.length!==12||cipher.length>1_900_000)throw Error('暗号化データサイズまたは形式が不正');
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
    let buf;
    try{buf=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:secureAAD},key,cipher)}
    catch(_){throw Error('復号に失敗しました。パスフレーズまたは公開データを確認');}
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buf));
    if(!Array.isArray(payload.observations)||!Array.isArray(payload.runs))throw Error('復号データの形式が不正');
    return payload;
  }
  async function encryptedSync(){
    if(!session.encryptedPassphrase||session.busy)return;
    const epoch=++session.epoch;
    session.busy=true;controls();setStatus('⏳ 暗号化された監視データを取得しています…');
    try{
      const response=await fetch(secureUrl+'?t='+Date.now(),{cache:'no-store',redirect:'error'});
      if(!response.ok)throw Error('公開暗号化データの取得エラー HTTP '+response.status);
      const envelope=await response.json();
      const payload=await decryptSnapshot(envelope,session.encryptedPassphrase);
      const obs=validateObs(payload.observations),runs=validateRuns(payload.runs);
      if(epoch!==session.epoch)return;
      session.obs=obs.rows;session.runs=runs;session.duplicates=obs.duplicates;
      session.checked=Date.now();session.error=false;session.source='encrypted';
      setStatus('✅ 暗号化同期：観測 '+session.obs.length+'件 ／ 実行 '+session.runs.length+'件。復号キーは保存しません。');
      render();
    }catch(err){if(epoch!==session.epoch)return;session.error=true;setStatus('❌ 暗号化同期：'+(err instanceof Error?err.message:'失敗')+'。前回の表示を保持します。',true);renderFreshness();}
    finally{session.busy=false;controls();}
  }
  $('encryptedConnectBtn').addEventListener('click',()=>{
    const pass=$('syncPassphrase').value;$('syncPassphrase').value='';
    if(pass.length<32){setStatus('❌ パスフレーズは32文字以上で入力してください。',true);return;}
    session.encryptedPassphrase=pass;session.token=null;session.repo=null;
    $('autoRefresh').checked=false;void encryptedSync();
  });
  $('encryptedDisconnectBtn').addEventListener('click',()=>{
    session.epoch++;session.encryptedPassphrase=null;session.error=false;
    $('syncPassphrase').value='';$('encryptedAutoRefresh').checked=false;
    setStatus('🔒 復号キーを破棄しました。表示済みデータは画面を閉じるまで残ります。');render();
  });
  const oldMaybeSync=maybeSync;
  setInterval(()=>{
    if(!document.hidden&&$('encryptedAutoRefresh').checked&&session.encryptedPassphrase&&!session.busy&&Date.now()-session.checked>=300_000)void encryptedSync();
  },30_000);
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden&&session.encryptedPassphrase&&$('encryptedAutoRefresh').checked&&Date.now()-session.checked>=300_000)void encryptedSync();
  });
  window.addEventListener('pagehide',()=>{session.encryptedPassphrase=null;$('syncPassphrase').value='';});
  controls();render();
})();
