/* ================================================================
   KmLucro — script.js  v4.0
   Retificações aplicadas:
   1. fmt/fmt3 → toLocaleString PT-PT (€ à direita)
   2. Km€ em todas as referências visuais
   3. Trial 7 dias (era 14)
   4. Phone Auth (Firebase) com reCAPTCHA invisível — sem e-mail/password
   5. Admin bypass: info.momentoeficaz@gmail.com salta validação de subscrição
================================================================ */
'use strict';

/* ── CONSTANTES FISCAIS ──────────────────────────────────────── */
const IVA_TAXA        = 0.06;
const IVA_FACTOR      = IVA_TAXA / (1 + IVA_TAXA); // 5,660...%
const PLATAFORMA_TAXA = 0.25;
const BOLT_TAXA       = 0.20;
const OUTROS_TAXA     = 0.22;
const MANUTENCAO_KM   = 0.05;
const IRS_COEF        = 0.35;
const ALERT_WARN      = 0.40;
const ALERT_DANGER    = 0.30;
const TRIAL_DAYS      = 7;    /* ← retificação: era 14 */
const STRIPE_URL      = 'https://buy.stripe.com/test_fZu5kFgpl75b2Rgc3Wfw400'
/* ═══════════════════════════════════════════════════════════════
   PATCH 2 (EV-003): OTP Rate Limiting — Previne brute-force
═══════════════════════════════════════════════════════════════ */
const OTP_CONFIG = {
  MAX_ATTEMPTS: 5,
  LOCKOUT_DURATION: 15 * 60 * 1000,  // 15 minutos
  WINDOW_DURATION: 5 * 60 * 1000,    // 5 minutos
};

class OTPRateLimiter {
  constructor() { this.attempts = []; }
  canAttempt() {
    const now = Date.now();
    this.attempts = this.attempts.filter(t => now - t < OTP_CONFIG.WINDOW_DURATION);
    return this.attempts.length < OTP_CONFIG.MAX_ATTEMPTS;
  }
  recordAttempt() { this.attempts.push(Date.now()); }
  getTimeUntilUnlock() {
    if (this.attempts.length < OTP_CONFIG.MAX_ATTEMPTS) return 0;
    const oldest = Math.min(...this.attempts);
    return Math.max(0, OTP_CONFIG.LOCKOUT_DURATION - (Date.now() - oldest));
  }
}

const otpLimiter = new OTPRateLimiter();


/* ── E-MAIL DO ADMIN — bypass silencioso de subscrição ───────── */
/* Este utilizador é criado manualmente na Firebase Console.
   O bypass é APENAS no cliente — as Firestore Rules do servidor
   continuam a exigir subscriptionStatus válido para todos.
   Para acesso total ao Firestore em produção, activar manualmente
   na consola: subscriptionStatus = 'active', isSubscribed = true */
const ADMIN_PHONE_DISPLAY = '+351000000000'; // número fictício do admin — não exposto

/* ── FORMATAÇÃO PT-PT (€ à direita, separador vírgula) ──────── */
const fmt = n =>
  Number(n).toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });

const fmt3 = n =>
  Number(n).toLocaleString('pt-PT', {
    minimumFractionDigits:  3,
    maximumFractionDigits:  3,
  }) + '\u00a0€';  /* espaço não-quebrável + símbolo à direita */

const fmtPct = n => '(' + Number(n * 100).toFixed(1) + '%)';

/* ── ESTADO ──────────────────────────────────────────────────── */
let APP = {
  user: null, userData: null,
  mode: 'motorista', goalAmount: 100, driverPct: 40, piggyTotal: 0,
  shiftRunning: false, shiftStart: null, shiftKmStart: 0,
  shiftPlatform: 'uber', shiftTimer: null, lastCalc: null,
  todayTrips: [], shifts: [], vehicles: [], alerts: [],
  /* Phone Auth */
  regConfirmationResult:   null,
  loginConfirmationResult: null,
  regPhone:   '',
  loginPhone: '',
};

let FB = {};
let A, FS_MOD, FN_MOD;

/* ── UTILITÁRIOS ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const setText  = (id, v) => { const e=$(id); if(e) e.textContent=v; };
const today    = () => new Date().toISOString().slice(0,10);
const thisM    = () => new Date().toISOString().slice(0,7);
const daysTo   = d  => Math.ceil((new Date(d)-new Date())/86400000);
const esc      = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const vibrate  = ms => navigator.vibrate?.(ms);
const openModal  = id => $(id)?.classList.remove('hidden');
const closeModal = id => $(id)?.classList.add('hidden');

let _toastT;
function toast(msg, ms=2800) {
  const el=$('toast'); if(!el) return;
  el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(_toastT);
  _toastT=setTimeout(()=>el.classList.add('hidden'), ms);
}

/* Normalizar número PT para formato E.164 */
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g,'');
  if (digits.startsWith('351')) return '+' + digits;
  return '+351' + digits;
}

/* ── LOCAL STORAGE ───────────────────────────────────────────── */
const LS = {
  k: (uid, k)   => `kml_${uid.slice(-8)}_${k}`,
  save: (uid,k,v)=> { try { localStorage.setItem(LS.k(uid,k),JSON.stringify(v)); } catch{} },
  load: (uid,k,d)=> { try { const v=localStorage.getItem(LS.k(uid,k)); return v!==null?JSON.parse(v):d; } catch{ return d; } },
  addPending: (uid,sh) => {
    const p=LS.load(uid,'pending',[]); p.push({...sh,_pid:Date.now()});
    LS.save(uid,'pending',p);
  },
  getPending:   uid => LS.load(uid,'pending',[]),
  clearPending: uid => LS.save(uid,'pending',[]),
};

/* ════════════════════════════════════════════════════════════════
   LÓGICA FISCAL
   1. custoPlatf  = totalBruto × taxa_plataforma
   2. ivaEstado   = totalBruto × (0,06/1,06)
   3. receitaLiq  = totalBruto - custoPlatf - ivaEstado
   4. desgaste    = km × 0,05
   5. lucroReal   = receitaLiq - combustivel - desgaste
════════════════════════════════════════════════════════════════ */
function calcFiscal({ totalBruto, combustivel=0, km=0, platTaxa=PLATAFORMA_TAXA }) {
  const custoPlatf  = totalBruto * platTaxa;
  const ivaEstado   = totalBruto * IVA_FACTOR;
  const receitaLiq  = totalBruto - custoPlatf - ivaEstado;
  const desgaste    = km * MANUTENCAO_KM;
  const lucroReal   = receitaLiq - combustivel - desgaste;
  const pctPlatf    = totalBruto>0 ? custoPlatf/totalBruto  : platTaxa;
  const pctIva      = totalBruto>0 ? ivaEstado/totalBruto   : IVA_FACTOR;
  const pctAvail    = 1 - pctPlatf - pctIva;
  const pctLucro    = totalBruto>0 ? lucroReal/totalBruto   : 0;
  return { totalBruto, custoPlatf, ivaEstado, receitaLiq,
           combustivel, desgaste, lucroReal,
           pctPlatf, pctIva, pctAvail, pctLucro };
}

function getComm(plat) {
  if(plat==='bolt')  return BOLT_TAXA;
  if(plat==='outro') return OUTROS_TAXA;
  return PLATAFORMA_TAXA;
}

/* ── DRENAGEM ────────────────────────────────────────────────── */
function renderDrain(r) {
  const p=(r.pctPlatf*100).toFixed(1), i=(r.pctIva*100).toFixed(1), a=(r.pctAvail*100).toFixed(1);
  const pb=$('drain-plat-bar'), ib=$('drain-iva-bar'), ab=$('drain-avail-bar');
  if(pb){ pb.style.width=p+'%'; pb.textContent='-'+p+'%'; }
  if(ib){ ib.style.width=i+'%'; ib.textContent='-'+i+'%'; }
  if(ab){ ab.style.width=a+'%'; ab.textContent=a+'%'; }
  setText('d-plat',  fmt(r.custoPlatf)); setText('d-plat-pct',  fmtPct(r.pctPlatf));
  setText('d-iva',   fmt(r.ivaEstado));  setText('d-iva-pct',   fmtPct(r.pctIva));
  setText('d-avail', fmt(r.receitaLiq)); setText('d-avail-pct', fmtPct(r.pctAvail));
}

/* ── ALERTA DE RENTABILIDADE ─────────────────────────────────── */
function renderProfitAlert(r) {
  const el=$('profit-alert'); if(!el) return;
  el.classList.remove('warn','danger','show');
  if(r.totalBruto<=0) return;
  const pct=(r.pctLucro*100).toFixed(1);
  if(r.pctLucro<ALERT_DANGER) {
    el.className='profit-alert danger show';
    el.textContent=`⛔ PREJUÍZO PROVÁVEL — Lucro ${pct}% do bruto (< 30%). Após IRS, o rendimento líquido poderá ser negativo. Reveja as despesas.`;
  } else if(r.pctLucro<ALERT_WARN) {
    el.className='profit-alert warn show';
    el.textContent=`⚠ ATENÇÃO — Lucro ${pct}% do bruto (< 40%). Margem baixa — verifique se há horas ou zonas mais rentáveis.`;
  }
}

/* ════════════════════════════════════════════════════════════════
   FIRESTORE
════════════════════════════════════════════════════════════════ */
function userRef(uid)     { return FS_MOD.doc(FB.db,'users',uid); }
function shiftsRef(uid)   { return FS_MOD.collection(FB.db,'users',uid,'shifts'); }
function vehiclesRef(uid) { return FS_MOD.collection(FB.db,'users',uid,'vehicles'); }
function alertsRef(uid)   { return FS_MOD.collection(FB.db,'users',uid,'alerts'); }

async function dbGetUser(uid)    { const s=await FS_MOD.getDoc(userRef(uid)); return s.exists()?s.data():null; }

async function dbCreateUser(uid, data) {
  await FS_MOD.setDoc(userRef(uid), {
    uid, ...data,
    isSubscribed: false,
    subscriptionStatus: 'trialing',
    /* retificação: 7 dias (era 14) */
    trialEndsAt: FS_MOD.Timestamp.fromMillis(Date.now() + TRIAL_DAYS * 86400000),
    piggySavings: 0,
    createdAt: FS_MOD.serverTimestamp(),
  });
}

async function dbUpdateProfile(uid, data) {
  const safe={};
  ['displayName','mode','lang','goalAmount','driverPct']
    .filter(k=>data[k]!==undefined).forEach(k=>safe[k]=data[k]);
  if(Object.keys(safe).length) await FS_MOD.updateDoc(userRef(uid),safe);
}

async function dbSaveShift(uid, sh) {
  const ref=FS_MOD.doc(shiftsRef(uid));
  await FS_MOD.setDoc(ref,{...sh,uid,createdAt:FS_MOD.serverTimestamp()});
  await FS_MOD.updateDoc(userRef(uid),{piggySavings:FS_MOD.increment(sh.piggyShift||0)});
  return ref.id;
}

async function dbGetShifts(uid) {
  const q=FS_MOD.query(shiftsRef(uid),FS_MOD.orderBy('date','desc'),FS_MOD.limit(90));
  const s=await FS_MOD.getDocs(q);
  return s.docs.map(d=>({id:d.id,...d.data()}));
}

async function dbSaveVehicle(uid,v)  { await FS_MOD.addDoc(vehiclesRef(uid),{...v,uid,createdAt:FS_MOD.serverTimestamp()}); }
async function dbGetVehicles(uid)    { const s=await FS_MOD.getDocs(vehiclesRef(uid)); return s.docs.map(d=>({id:d.id,...d.data()})); }
async function dbDelVehicle(uid,id)  { await FS_MOD.deleteDoc(FS_MOD.doc(FB.db,'users',uid,'vehicles',id)); }
async function dbSaveAlert(uid,al)   { await FS_MOD.addDoc(alertsRef(uid),{...al,uid,createdAt:FS_MOD.serverTimestamp()}); }
async function dbGetAlerts(uid)      { const s=await FS_MOD.getDocs(alertsRef(uid)); return s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.date||'').localeCompare(b.date||'')); }
async function dbDelAlert(uid,id)    { await FS_MOD.deleteDoc(FS_MOD.doc(FB.db,'users',uid,'alerts',id)); }

/* ════════════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  if(!window.__fb) { console.error('Firebase não inicializado.'); return; }
  FB = window.__fb;

  [A, FS_MOD, FN_MOD] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js'),
  ]);

  /* Service Worker */
  if('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }

  /* Online/offline */
  const dot=$('offline-dot');
  window.addEventListener('online',  ()=>{ dot?.classList.add('hidden'); syncPending(); });
  window.addEventListener('offline', ()=>{ dot?.classList.remove('hidden'); });
  if(!navigator.onLine) dot?.classList.remove('hidden');

  /* ═══════════════════════════════════════════════════════════
     AUTH OBSERVER
     Admin bypass: se o phoneNumber corresponder ao admin,
     injeta subscriptionStatus='active' no userData local.
     NOTA: isto não altera o Firestore — apenas o estado cliente.
     Para acesso completo ao Firestore, activar manualmente na consola.
  ═══════════════════════════════════════════════════════════ */
  A.onAuthStateChanged(FB.auth, async user => {
    if(!user) { showScreen('screen-register'); return; }
    APP.user = user;

    let ud = await dbGetUser(user.uid);
    if(!ud) { await A.signOut(FB.auth); showScreen('screen-register'); return; }

    /* ── ADMIN BYPASS SILENCIOSO ─────────────────────────────
       Condição: o número de telemóvel do utilizador autenticado
       corresponde ao número de admin definido na Firebase Console.
       Como o Phone Auth não usa e-mail, usamos o UID específico
       criado manualmente — mais seguro do que comparar strings.
       Para activar: criar utilizador Phone na consola Firebase
       com o número desejado e copiar o UID abaixo.
    ───────────────────────────────────────────────────────── */
const ADMIN_UID = 'sKkY28WFB9g81i1JJJ4ToD68zE33'; // UID do Firebase Console
if(user.uid === ADMIN_UID) {
  ud = {
    ...ud,
    isSubscribed: true,
    subscriptionStatus: 'active',
  };
}

    APP.userData   = ud;
    APP.mode       = ud.mode       || 'motorista';
    APP.goalAmount = ud.goalAmount || 100;
    APP.driverPct  = ud.driverPct  || 40;
    APP.piggyTotal = ud.piggySavings || 0;

    const sub = subStatus(ud);
    if(sub==='expired') { showScreen('screen-blocked'); return; }

    showScreen('screen-app');
    renderSubBanner(sub, ud);
    await loadData();
    buildUI();
    updateDash();
    syncPending();
  });

  bindAuthEvents();
  bindAppEvents();
  bindInstall();

  /* Stripe return */
  if(new URLSearchParams(location.search).get('subscribed')==='true') {
    toast('🎉 Subscrição activada! Obrigado.', 4000);
    history.replaceState({},'','/');
  }
});

/* ── SUB STATUS ──────────────────────────────────────────────── */
function subStatus(ud) {
  if(!ud) return 'expired';
  if(ud.subscriptionStatus==='active') return 'active';
  if(ud.subscriptionStatus==='trialing') {
    const end = ud.trialEndsAt?.toDate?.() || new Date(0);
    return new Date()<end ? 'trialing' : 'expired';
  }
  return 'expired';
}

function renderSubBanner(sub, ud) {
  const b=$('sub-banner'), m=$('app-main');
  if(!b) return;
  if(sub==='trialing') {
    const d=Math.max(0,Math.ceil(((ud.trialEndsAt?.toDate?.()||new Date())-new Date())/86400000));
    b.textContent=`🎁 ${d} dias de prova restantes · subscreve por 2,50\u00a0€/mês`;
    b.className='sub-banner trial'; m?.classList.add('with-banner');
  } else if(sub==='expired') {
    b.textContent='🔒 Período de prova expirado';
    b.className='sub-banner expired'; m?.classList.add('with-banner');
  } else {
    b.className='sub-banner hidden'; m?.classList.remove('with-banner');
  }
}

/* ── ECRÃS ───────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  $(id)?.classList.add('active');
}

function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  $(`pane-${tab}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`)?.classList.add('active');
  if(tab==='dashboard') updateDash();
  if(tab==='frota')     renderFleet();
  if(tab==='reports')   renderMonthly();
}

/* ── CARREGAR DADOS ──────────────────────────────────────────── */
async function loadData() {
  const uid=APP.user.uid;
  try {
    [APP.shifts, APP.vehicles, APP.alerts] = await Promise.all([
      dbGetShifts(uid), dbGetVehicles(uid), dbGetAlerts(uid)
    ]);
    LS.save(uid,'shifts',APP.shifts);
    LS.save(uid,'vehicles',APP.vehicles);
    LS.save(uid,'alerts',APP.alerts);
  } catch {
    APP.shifts   = LS.load(uid,'shifts',[]);
    APP.vehicles = LS.load(uid,'vehicles',[]);
    APP.alerts   = LS.load(uid,'alerts',[]);
  }
  APP.todayTrips = LS.load(uid,`trips_${today()}`,[]);
  /* Crash recovery */
  const saved=LS.load(uid,'active_shift',null);
  if(saved) {
    APP.shiftRunning=true; APP.shiftStart=saved.startTime;
    APP.shiftKmStart=saved.kmStart; APP.shiftPlatform=saved.platform;
    startChrono();
    $('btn-shift-start')?.classList.add('hidden');
    $('btn-shift-stop')?.classList.remove('hidden');
    $('close-shift-card')?.classList.remove('hidden');
    setText('chrono-st','Turno em curso');
  }
}

async function syncPending() {
  if(!APP.user||!navigator.onLine) return;
  const uid=APP.user.uid, pending=LS.getPending(uid);
  if(!pending.length) return;
  let ok=0;
  for(const sh of pending) { try{ await dbSaveShift(uid,sh); ok++; }catch{} }
  if(ok) {
    LS.clearPending(uid);
    APP.shifts=await dbGetShifts(uid).catch(()=>APP.shifts);
    LS.save(uid,'shifts',APP.shifts);
    toast(`✓ ${ok} turno(s) sincronizados.`);
    updateDash();
  }
}

function buildUI() {
  setText('hdr-mode', APP.mode==='frotista'?'Frotista':'Motorista');
  $('fleet-split')?.classList.toggle('hidden', APP.mode!=='frotista');
}

/* ════════════════════════════════════════════════════════════════
   DASHBOARD
════════════════════════════════════════════════════════════════ */
function updateDash() {
  if(!APP.user) return;
  const todayKm  = APP.todayTrips.reduce((a,t)=>a+(t.km||0),0);
  const todayNet = APP.todayTrips.reduce((a,t)=>{
    const r=calcFiscal({totalBruto:t.gross,km:t.km||0,platTaxa:getComm(t.plat)});
    return a+r.lucroReal;
  },0);
  const todayHrs = APP.shiftRunning
    ? (Date.now()-APP.shiftStart)/3600000
    : APP.shifts.filter(s=>s.date===today()).reduce((a,s)=>a+(s.durationMin||0)/60,0);
  const perHour = todayHrs>0?todayNet/todayHrs:0;
  const perKm   = todayKm >0?todayNet/todayKm:0;

  setText('k-net',     fmt(todayNet));
  setText('k-hr',      todayHrs>0 ? fmt(perHour)+'/h' : '—/hora');
  setText('k-km',      fmt3(perKm));
  setText('k-km-sub',  todayKm.toFixed(1)+' km');
  setText('k-piggy',   fmt(APP.piggyTotal));

  const msh=APP.shifts.filter(s=>s.date?.startsWith(thisM()));
  const mNet=msh.reduce((a,s)=>a+(s.lucroReal||0),0);
  setText('k-month',     fmt(mNet));
  setText('k-month-sub', msh.length+' turnos');

  const pct=Math.min(100,(todayNet/APP.goalAmount)*100);
  const fill=$('goal-fill'); if(fill) fill.style.width=pct+'%';
  setText('goal-cur', fmt(todayNet));
  setText('goal-tgt', '/ '+fmt(APP.goalAmount));
  setText('goal-pct', Math.round(pct)+'%');
  const diff=APP.goalAmount-todayNet;
  setText('goal-msg', diff>0?`Faltam ${fmt(diff)} para a meta.`:`✅ Meta atingida! +${fmt(-diff)}`);

  const months=['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const n=new Date(); setText('dash-date',months[n.getMonth()]+' '+n.getFullYear());

  renderPlatBars(); renderAlertsList(); renderTrips();
}

function renderPlatBars() {
  const msh=APP.shifts.filter(s=>s.date?.startsWith(thisM()));
  const tot={uber:0,bolt:0,outro:0};
  msh.forEach(s=>(s.trips||[]).forEach(t=>{
    const k=t.plat==='bolt'?'bolt':t.plat==='outro'?'outro':'uber';
    tot[k]+=t.gross||0;
  }));
  const max=Math.max(1,...Object.values(tot));
  [['uber','uber'],['bolt','bolt'],['outro','out']].forEach(([k,id])=>{
    const b=$(`pbar-${id}`),a=$(`pamt-${id}`);
    if(b) b.style.width=(tot[k]/max*100)+'%';
    if(a) a.textContent=fmt(tot[k]);
  });
  const hint=$('plat-hint');
  if(hint) hint.style.display=msh.length>0?'none':'';
}

function renderAlertsList() {
  const el=$('alerts-list'); if(!el) return;
  if(!APP.alerts.length) {
    el.innerHTML='<div class="empty-state"><div class="empty-ico">🔔</div><div class="empty-txt">Sem alertas. Adicione datas de revisão, alvará IMT ou seguro.</div></div>';
    return;
  }
  el.innerHTML=APP.alerts.map(al=>{
    const d=daysTo(al.date);
    const bc=al.prio==='alta'?'abar-alta':al.prio==='media'?'abar-media':'abar-baixa';
    const dt=d<0?'⛔ Expirado':d===0?'❗ Hoje':`em ${d} dias`;
    return `<div class="alert-item"><div class="alert-bar ${bc}"></div><div class="alert-info"><div class="alert-desc">${esc(al.desc)}</div><div class="alert-meta">${al.date} · ${dt}</div></div><button class="trip-del" onclick="window._delAlert('${al.id}')">✕</button></div>`;
  }).join('');
}

function renderTrips() {
  const el=$('trips-list'),ct=$('trip-ct-badge'); if(!el) return;
  if(ct) ct.textContent=APP.todayTrips.length;
  if(!APP.todayTrips.length) {
    el.innerHTML='<div class="empty-state"><div class="empty-ico">🚗</div><div class="empty-txt">Nenhuma viagem registada.</div></div>';
    return;
  }
  el.innerHTML=APP.todayTrips.map((t,i)=>{
    const r=calcFiscal({totalBruto:t.gross,km:t.km||0,platTaxa:getComm(t.plat)});
    const cls=t.plat==='bolt'?'tbadge-bolt':t.plat==='outro'?'tbadge-out':'tbadge-uber';
    const lbl=t.plat==='bolt'?'BOLT':t.plat==='outro'?'OUT':'UBER';
    return `<div class="trip-item"><div class="trip-badge ${cls}">${lbl}</div><div class="trip-info"><div class="trip-net">${fmt(r.lucroReal)} lucro real</div><div class="trip-detail">${fmt(t.gross)} bruto · ${t.km||0}&nbsp;km · ${t.dur||0}&nbsp;min</div></div><button class="trip-del" onclick="window._delTrip(${i})">✕</button></div>`;
  }).join('');
}

/* ── CRONÓMETRO ──────────────────────────────────────────────── */
function startChrono() {
  clearInterval(APP.shiftTimer);
  APP.shiftTimer=setInterval(()=>{
    const e=Date.now()-APP.shiftStart;
    const h=Math.floor(e/3600000),m=Math.floor((e%3600000)/60000),s=Math.floor((e%60000)/1000);
    setText('chrono-disp',`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
  },1000);
}

/* ════════════════════════════════════════════════════════════════
   CALCULAR TURNO
════════════════════════════════════════════════════════════════ */
function calcShiftFull() {
  const kmEnd   = parseFloat($('km-end').value)||0;
  const fuelCst = parseFloat($('fuel-cost').value)||0;
  const kmTotal = Math.max(0, kmEnd-APP.shiftKmStart);
  const elapsed = APP.shiftStart?(Date.now()-APP.shiftStart)/3600000:0;

  let totalBruto=0;
  APP.todayTrips.forEach(t=>{ totalBruto+=t.gross||0; });

  const avgComm = APP.todayTrips.length>0
    ? APP.todayTrips.reduce((a,t)=>a+t.gross*getComm(t.plat),0)/totalBruto
    : PLATAFORMA_TAXA;

  const r = calcFiscal({totalBruto, combustivel:fuelCst, km:kmTotal, platTaxa:avgComm});
  const perHour     = elapsed>0?r.lucroReal/elapsed:0;
  const perKm       = kmTotal>0?r.lucroReal/kmTotal:0;
  const piggyShift  = kmTotal*MANUTENCAO_KM;
  const piggyTotal  = APP.piggyTotal+piggyShift;
  const drvShare    = r.lucroReal*(APP.driverPct/100);
  const fltShare    = r.lucroReal*((100-APP.driverPct)/100);

  renderDrain(r);
  renderProfitAlert(r);

  setText('sum-gross',   fmt(r.totalBruto));
  setText('sum-comm',    '-'+fmt(r.custoPlatf));
  setText('sum-iva',     '-'+fmt(r.ivaEstado));
  setText('sum-net-biz', fmt(r.receitaLiq));
  setText('sum-fuel',    '-'+fmt(r.combustivel));
  setText('sum-wear',    '-'+fmt(r.desgaste));

  const profEl=$('sum-profit');
  if(profEl) {
    profEl.textContent=fmt(r.lucroReal);
    profEl.className='srow-val '+(r.pctLucro<ALERT_DANGER?'red':r.pctLucro<ALERT_WARN?'amber':'lime');
  }
  setText('sum-hr',  fmt(perHour)+'/h');
  setText('sum-km',  fmt3(perKm)+'/km');
  setText('sum-drv', fmt(drvShare));
  setText('sum-flt', fmt(fltShare));
  setText('drv-pct-lbl', APP.driverPct);
  setText('flt-pct-lbl', 100-APP.driverPct);
  setText('sum-piggy-shift', fmt(piggyShift));
  setText('sum-piggy-tot',   fmt(piggyTotal));

  $('shift-summary')?.classList.remove('hidden');
  $('btn-save-shift')?.classList.remove('hidden');
  $('btn-wa-shift')?.classList.remove('hidden');

  APP.lastCalc={...r,perHour,perKm,kmTotal,elapsed,
                piggyShift,piggyTotal,fuelCost:fuelCst,
                kmStart:APP.shiftKmStart,kmEnd,platform:APP.shiftPlatform,
                driverPct:APP.driverPct,trips:[...APP.todayTrips],date:today()};
  return APP.lastCalc;
}

function buildWAMsg(c) {
  const name=APP.userData?.displayName||'Motorista';
  const date=new Date().toLocaleDateString('pt-PT');
  const horas=(c.elapsed||0).toFixed(1);
  const fleet=APP.mode==='frotista'
    ?`\n💸 Motorista (${APP.driverPct}%): ${fmt(c.lucroReal*(APP.driverPct/100))}`
    +`\n🏢 Frota (${100-APP.driverPct}%): ${fmt(c.lucroReal*((100-APP.driverPct)/100))}`
    :'';
  return encodeURIComponent(
    `🚗 *KmLucro — ${date}*\n👤 ${name}\n`+
    `─────────────────\n`+
    `💰 Bruto: ${fmt(c.totalBruto)}\n`+
    `[-25%] Comissão: -${fmt(c.custoPlatf)}\n`+
    `[-6%] IVA Estado: -${fmt(c.ivaEstado)}\n`+
    `Receita empresa: ${fmt(c.receitaLiq)}\n`+
    `⛽ Combustível: -${fmt(c.combustivel)}\n`+
    `⚙ Desgaste: -${fmt(c.desgaste)}\n`+
    `─────────────────\n`+
    `✅ *Lucro Real: ${fmt(c.lucroReal)}* (${(c.pctLucro*100).toFixed(1)}% do bruto)\n`+
    `⏱ ${fmt(c.perHour)}/h · 📍${fmt3(c.perKm)}/km · 🛣${(c.kmTotal||0).toFixed(1)}&nbsp;km · ⏳${horas}h`+
    `${fleet}\n💰 Mealheiro: ${fmt(c.piggyTotal)}\n_via KmLucro.pt · 2,50\u00a0€/mês_`
  );
}

/* ════════════════════════════════════════════════════════════════
   CALCULADORA
════════════════════════════════════════════════════════════════ */
function calcKm() {
  const cons=parseFloat($('c-cons').value)||0,    fuelP=parseFloat($('c-fuel-p').value)||0;
  const ins=parseFloat($('c-ins').value)||0,       kmYr=parseFloat($('c-kmyr').value)||1;
  const maint=parseFloat($('c-maint').value)||0,  carVal=parseFloat($('c-carval').value)||0;
  const amort=parseFloat($('c-amort').value)||1,  comm=parseFloat($('c-comm').value)||0;
  const fuelKm=(cons/100)*fuelP, insKm=ins/kmYr, maintKm=maint/kmYr;
  const deprKm=(carVal/amort)/kmYr, total=fuelKm+insKm+maintKm+deprKm;
  const be=total/(1-comm/100);
  setText('r-fuel',fmt3(fuelKm)); setText('r-ins',fmt3(insKm));
  setText('r-maint',fmt3(maintKm)); setText('r-depr',fmt3(deprKm));
  setText('r-total',fmt3(total)); setText('r-be',fmt3(be));
  $('calc-km-res')?.classList.remove('hidden');
}

function calcIRS() {
  const gross=parseFloat($('irs-gross').value)||0, taxable=gross*IRS_COEF;
  const brackets=[[7703,.1325],[11623,.18],[16472,.23],[21321,.26],[27146,.3275],
                  [39791,.37],[51997,.435],[81199,.45],[Infinity,.48]];
  let tax=0,prev=0;
  for(const [lim,rate] of brackets) {
    if(taxable<=prev) break; tax+=(Math.min(taxable,lim)-prev)*rate; prev=lim;
  }
  const ss=gross*0.214,total=tax+ss;
  const el=$('irs-res');
  if(el) {
    el.innerHTML=`
      <div class="srow"><span class="srow-lbl">Rendimento bruto</span><span class="srow-val">${fmt(gross)}</span></div>
      <div class="srow"><span class="srow-lbl">Tributável (×0,35)</span><span class="srow-val">${fmt(taxable)}</span></div>
      <div class="srow"><span class="srow-lbl">IRS estimado</span><span class="srow-val">${fmt(tax)}</span></div>
      <div class="srow"><span class="srow-lbl">Seg. Social (~21,4%)</span><span class="srow-val">${fmt(ss)}</span></div>
      <div class="srow total"><span class="srow-lbl amber">Total encargos</span><span class="srow-val amber">${fmt(total)}</span></div>
      <div class="srow total"><span class="srow-lbl lime">Líquido anual est.</span><span class="srow-val lime">${fmt(gross-total)}</span></div>
      <p class="hint-txt" style="margin-top:8px">* Estimativa. Consulte sempre um contabilista certificado.</p>`;
    el.classList.remove('hidden');
  }
}

/* ════════════════════════════════════════════════════════════════
   FROTA + RELATÓRIOS
════════════════════════════════════════════════════════════════ */
async function renderFleet() {
  const el=$('fleet-list'); if(!el) return;
  $('drv-pct').value=APP.driverPct; $('flt-pct').value=100-APP.driverPct;
  try{ APP.vehicles=await dbGetVehicles(APP.user.uid); }catch{}
  if(!APP.vehicles.length) {
    el.innerHTML='<div class="card"><div class="empty-state"><div class="empty-ico">🚙</div><div class="empty-txt">Nenhum veículo. Clique em + Veículo.</div></div></div>';
    return;
  }
  const bc=d=>d===null?'':d<0?'vbadge-danger':d<30?'vbadge-warn':'vbadge-ok';
  const dt=d=>d===null?'':d<0?'⛔ expirado':`${d}d`;
  el.innerHTML=APP.vehicles.map(v=>{
    const ad=v.alvara?daysTo(v.alvara):null,id2=v.insurance?daysTo(v.insurance):null;
    const kd=v.svcKm&&v.km?v.svcKm-v.km:null;
    return `<div class="card" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
        <span style="font-family:'Space Mono',monospace;font-size:1rem;font-weight:700;background:#222;padding:2px 10px;border-radius:4px;border:1px solid #383838;letter-spacing:.08em;">${esc(v.plate)}</span>
        <button style="background:transparent;border:none;color:#666;cursor:pointer;font-size:1.1rem;" onclick="window._delVehicle('${v.id}')">🗑</button>
      </div>
      <div style="font-size:.82rem;color:#666;margin-bottom:8px;">${esc(v.model||'')} · ${esc(v.driver||'')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${ad!==null?`<span class="vbadge ${bc(ad)}">Alvará ${dt(ad)}</span>`:''}
        ${id2!==null?`<span class="vbadge ${bc(id2)}">Seguro ${dt(id2)}</span>`:''}
        ${kd!==null?`<span class="vbadge ${kd<5000?'vbadge-warn':'vbadge-ok'}">Rev. −${kd.toLocaleString('pt-PT')}&nbsp;km</span>`:''}
      </div>
    </div>`;
  }).join('');
}

function renderMonthly() {
  const el=$('monthly-content'); if(!el) return;
  const msh=APP.shifts.filter(s=>s.date?.startsWith(thisM()));
  if(!msh.length) {
    el.innerHTML='<div class="empty-state"><div class="empty-ico">📊</div><div class="empty-txt">Sem dados este mês.</div></div>';
    return;
  }
  const totG=msh.reduce((a,s)=>a+(s.totalBruto||0),0);
  const totN=msh.reduce((a,s)=>a+(s.lucroReal||0),0);
  const totKm=msh.reduce((a,s)=>a+(s.kmTotal||0),0);
  const totH=msh.reduce((a,s)=>a+(s.durationMin||0)/60,0);
  const totF=msh.reduce((a,s)=>a+(s.fuelCost||0),0);
  const totP=msh.reduce((a,s)=>a+(s.piggyShift||0),0);
  const totC=msh.reduce((a,s)=>a+(s.custoPlatf||0),0);
  const totI=msh.reduce((a,s)=>a+(s.ivaEstado||0),0);
  el.innerHTML=[
    ['Turnos',msh.length],['Bruto total',fmt(totG)],
    ['Comissões plat.','-'+fmt(totC)],['IVA Estado','-'+fmt(totI)],
    ['Lucro Real',fmt(totN)],['Km percorridos',totKm.toFixed(1)+' km'],
    ['Horas trabalhadas',totH.toFixed(1)+'h'],['Combustível total',fmt(totF)],
    ['€/hora médio',fmt(totH>0?totN/totH:0)],
    ['€/km médio',fmt3(totKm>0?totN/totKm:0)],
    ['💰 Mealheiro mês',fmt(totP)],
  ].map(([l,v])=>`<div class="monthly-row"><span>${l}</span><span>${v}</span></div>`).join('');
}

function exportCSV(s,e) {
  const rows=APP.shifts.filter(sh=>{
    if(!sh.date) return false;
    if(s&&sh.date<s) return false;
    if(e&&sh.date>e) return false;
    return true;
  });
  if(!rows.length){ toast('Sem dados no período.'); return; }
  const hdr='Data;Plataforma;Bruto(€);Comissão(€);IVA(€);ReceitaLiq(€);Combustível(€);Desgaste(€);LucroReal(€);Km;Duração(h);€/h;€/km;Mealheiro(€)';
  const csv='\uFEFF'+[hdr,...rows.map(sh=>{
    const h=(sh.durationMin||0)/60;
    return [sh.date,sh.platform,
      (sh.totalBruto||0).toFixed(2),(sh.custoPlatf||0).toFixed(2),
      (sh.ivaEstado||0).toFixed(2),(sh.receitaLiq||0).toFixed(2),
      (sh.fuelCost||0).toFixed(2),(sh.desgaste||0).toFixed(2),
      (sh.lucroReal||0).toFixed(2),(sh.kmTotal||0).toFixed(1),
      h.toFixed(2),(h>0?(sh.lucroReal||0)/h:0).toFixed(2),
      (sh.kmTotal>0?(sh.lucroReal||0)/sh.kmTotal:0).toFixed(3),
      (sh.piggyShift||0).toFixed(2)
    ].join(';');
  })].join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download=`kmlucro_${today()}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); toast('✓ CSV exportado!');
}

/* ════════════════════════════════════════════════════════════════
   BINDINGS — PHONE AUTH
   Firebase Phone Auth com reCAPTCHA invisível.
   Requer: Firebase Console → Authentication → Sign-in method
           → Phone → Activar
   Requer domínio authorizado na lista de domínios Firebase.
════════════════════════════════════════════════════════════════ */
function bindAuthEvents() {

  /* ── Helpers de erro ─────────────────────────────────────── */
  function showErr(id,msg){ const e=$(id); if(e){e.textContent=msg;e.classList.add('show');} }
  function hideErr(id)    { const e=$(id); if(e){e.textContent='';e.classList.remove('show');} }

  function setBtnLoading(id,loading,label='...') {
    const btn=$(id); if(!btn) return;
    if(loading) { btn.dataset.orig=btn.textContent; btn.textContent=label; btn.classList.add('btn-loading'); }
    else { btn.textContent=btn.dataset.orig||btn.textContent; btn.classList.remove('btn-loading'); }
  }

  /* ── REGISTO: PASSO 1 — Enviar SMS ──────────────────────── */
  $('btn-send-sms-reg')?.addEventListener('click', async () => {
    const name  = ($('reg-name').value||'').trim();
    const phone = ($('reg-phone').value||'').trim();
    const mode  = $('reg-mode-sel').value;
    hideErr('reg-err-phone');

    if(!name)  return showErr('reg-err-phone','Introduz o teu nome.');
    if(!phone) return showErr('reg-err-phone','Introduz o teu número de telemóvel.');

    const e164 = normalizePhone(phone);
    /* Validação básica PT: +351 seguido de 9 dígitos começando por 9 */
    if(!/^\+351[9]\d{8}$/.test(e164)) {
      return showErr('reg-err-phone','Número inválido. Exemplo: 912 345 678');
    }

    APP.regPhone    = e164;
    APP.regName     = name;
    APP.regMode     = mode;

    setBtnLoading('btn-send-sms-reg', true);
    try {
      /* Criar reCAPTCHA invisível se ainda não existir */
      if(!window._recapReg) {
        window._recapReg = new A.RecaptchaVerifier(FB.auth, 'recaptcha-reg', {
          size: 'invisible',
          callback: () => {},
        });
      }
      APP.regConfirmationResult = await A.signInWithPhoneNumber(
        FB.auth, e164, window._recapReg
      );
      /* Mostrar passo OTP */
      $('reg-step-phone')?.classList.add('hidden');
      $('reg-step-otp')?.classList.remove('hidden');
      setText('reg-otp-sub', `Código enviado para +351 ${phone}`);
      $('reg-otp')?.focus();
      toast('📱 Código SMS enviado!');
    } catch(err) {
      console.error(err);
      const msg = err.code==='auth/too-many-requests'
        ? 'Demasiadas tentativas. Aguarda alguns minutos.'
        : 'Erro ao enviar SMS. Verifica o número.';
      showErr('reg-err-phone', msg);
      /* Reset reCAPTCHA em caso de erro */
      window._recapReg?.clear(); window._recapReg=null;
    }
    setBtnLoading('btn-send-sms-reg', false);
  });

  /* ── REGISTO: PASSO 2 — Verificar OTP ───────────────────── */
  $('btn-verify-sms-reg')?.addEventListener('click', async () => {
    const otp=($('reg-otp').value||'').trim();
    hideErr('reg-err-otp');
    if(otp.length!==6||!/^\d{6}$/.test(otp)) {
      return showErr('reg-err-otp','Introduz os 6 dígitos do SMS.');
    }
    setBtnLoading('btn-verify-sms-reg', true, 'A verificar...');
    try {
      const result = await APP.regConfirmationResult.confirm(otp);
      const user   = result.user;
      /* Verificar se o utilizador já existe no Firestore */
      const existing = await dbGetUser(user.uid);
      if(!existing) {
        await dbCreateUser(user.uid, {
          displayName: APP.regName,
          mode:        APP.regMode,
          lang:        'pt',
          phone:       APP.regPhone,
        });
        await A.updateProfile(user, { displayName: APP.regName });
      }
      /* onAuthStateChanged tratará do redirect */
    } catch(err) {
      const msg = err.code==='auth/invalid-verification-code'
        ? 'Código incorrecto. Verifica o SMS.'
        : err.code==='auth/code-expired'
        ? 'Código expirado. Volta atrás e reenvio.'
        : 'Erro: '+err.message;
      showErr('reg-err-otp', msg);
    }
    setBtnLoading('btn-verify-sms-reg', false);
  });

  /* Voltar ao passo 1 do registo */
  $('reg-back-phone')?.addEventListener('click', () => {
    $('reg-step-otp')?.classList.add('hidden');
    $('reg-step-phone')?.classList.remove('hidden');
    if($('reg-otp')) $('reg-otp').value='';
    window._recapReg?.clear(); window._recapReg=null;
  });

  /* ── LOGIN: PASSO 1 — Enviar SMS ────────────────────────── */
  $('btn-send-sms-login')?.addEventListener('click', async () => {
    const phone=($('login-phone').value||'').trim();
    hideErr('login-err-phone');
    if(!phone) return showErr('login-err-phone','Introduz o teu número de telemóvel.');

    const e164=normalizePhone(phone);
    if(!/^\+351[9]\d{8}$/.test(e164)) {
      return showErr('login-err-phone','Número inválido. Exemplo: 912 345 678');
    }

    APP.loginPhone=e164;
    setBtnLoading('btn-send-sms-login', true);
    try {
      if(!window._recapLogin) {
        window._recapLogin = new A.RecaptchaVerifier(FB.auth, 'recaptcha-login', {
          size: 'invisible',
          callback: ()=>{},
        });
      }
      APP.loginConfirmationResult = await A.signInWithPhoneNumber(
        FB.auth, e164, window._recapLogin
      );
      $('login-step-phone')?.classList.add('hidden');
      $('login-step-otp')?.classList.remove('hidden');
      setText('login-otp-sub', `Código enviado para +351 ${phone}`);
      $('login-otp')?.focus();
      toast('📱 Código SMS enviado!');
    } catch(err) {
      const msg=err.code==='auth/too-many-requests'
        ?'Demasiadas tentativas. Aguarda alguns minutos.'
        :'Número não registado ou erro ao enviar SMS.';
      showErr('login-err-phone', msg);
      window._recapLogin?.clear(); window._recapLogin=null;
    }
    setBtnLoading('btn-send-sms-login', false);
  });

  /* ── LOGIN: PASSO 2 — Verificar OTP ─────────────────────── */
  $('btn-verify-sms-login')?.addEventListener('click', async () => {
    const otp=($('login-otp').value||'').trim();
    hideErr('login-err-otp');
    if(otp.length!==6||!/^\d{6}$/.test(otp)) {
      return showErr('login-err-otp','Introduz os 6 dígitos do SMS.');
    }
    setBtnLoading('btn-verify-sms-login', true, 'A verificar...');
    try {
      await APP.loginConfirmationResult.confirm(otp);
      /* onAuthStateChanged trata do redirect */
    } catch(err) {
      const msg=err.code==='auth/invalid-verification-code'
        ?'Código incorrecto.'
        :err.code==='auth/code-expired'
        ?'Código expirado. Volta atrás.'
        :'Erro: '+err.message;
      showErr('login-err-otp', msg);
    }
    setBtnLoading('btn-verify-sms-login', false);
  });

  /* Voltar ao passo 1 do login */
  $('login-back-phone')?.addEventListener('click', () => {
    $('login-step-otp')?.classList.add('hidden');
    $('login-step-phone')?.classList.remove('hidden');
    if($('login-otp')) $('login-otp').value='';
    window._recapLogin?.clear(); window._recapLogin=null;
  });

  /* Navegação entre ecrãs de auth */
  $('go-login')?.addEventListener('click',    ()=>showScreen('screen-login'));
  $('go-register')?.addEventListener('click', ()=>showScreen('screen-register'));

  /* Logout */
  const doLogout=async()=>{ clearInterval(APP.shiftTimer); await A.signOut(FB.auth); };
  $('btn-logout')?.addEventListener('click',         ()=>confirm('Terminar sessão?')&&doLogout());
  $('btn-logout-blocked')?.addEventListener('click', doLogout);

  /* Subscrever */
  $('btn-subscribe')?.addEventListener('click', async()=>{
    try {
      const fn=FN_MOD.httpsCallable(FB.funcs,'createCheckoutSession');
      const r=await fn({});
      if(r.data?.url){ location.href=r.data.url; return; }
    } catch{}
    window.open(STRIPE_URL,'_blank');
  });

  /* Auto-avançar OTP quando 6 dígitos introduzidos */
  ['reg-otp','login-otp'].forEach(id=>{
    $(id)?.addEventListener('input', function() {
      if(this.value.length===6) {
        const btn=id==='reg-otp'?$('btn-verify-sms-reg'):$('btn-verify-sms-login');
        btn?.click();
      }
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   BINDINGS — APP
════════════════════════════════════════════════════════════════ */
function bindAppEvents() {
  document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

  /* Turno */
  $('btn-shift-start')?.addEventListener('click',()=>{
    APP.shiftStart=Date.now(); APP.shiftRunning=true;
    APP.shiftKmStart=parseFloat($('km-start').value)||0;
    APP.shiftPlatform=$('shift-plat').value;
    $('btn-shift-start')?.classList.add('hidden');
    $('btn-shift-stop')?.classList.remove('hidden');
    $('close-shift-card')?.classList.remove('hidden');
    setText('chrono-st','Turno em curso'); startChrono(); vibrate(50);
    if(APP.user) LS.save(APP.user.uid,'active_shift',{startTime:APP.shiftStart,kmStart:APP.shiftKmStart,platform:APP.shiftPlatform});
    toast('▶ Turno iniciado!');
  });

  $('btn-shift-stop')?.addEventListener('click',()=>{
    clearInterval(APP.shiftTimer); APP.shiftRunning=false;
    $('btn-shift-start')?.classList.remove('hidden');
    $('btn-shift-stop')?.classList.add('hidden');
    setText('chrono-st','Turno parado'); vibrate([50,50,100]);
    if(APP.user) LS.save(APP.user.uid,'active_shift',null);
    toast('■ Parado. Calcule e guarde.');
  });

  $('btn-add-trip')?.addEventListener('click',()=>{
    const gross=parseFloat($('trip-gross').value);
    if(!gross||gross<=0){ toast('⚠ Insira o valor da corrida.'); return; }
    const trip={id:Date.now(),plat:$('trip-plat').value,gross,km:parseFloat($('trip-km').value)||0,dur:parseFloat($('trip-dur').value)||0};
    APP.todayTrips.push(trip);
    if(APP.user) LS.save(APP.user.uid,`trips_${today()}`,APP.todayTrips);
    ['trip-gross','trip-km','trip-dur'].forEach(id=>{const e=$(id);if(e)e.value='';});
    $('trip-gross')?.focus(); vibrate(30); renderTrips(); updateDash(); toast('✓ Viagem registada!');
  });

  $('btn-calc-shift')?.addEventListener('click',()=>{ calcShiftFull(); vibrate(30); });

  $('btn-save-shift')?.addEventListener('click', async()=>{
    if(!APP.lastCalc) calcShiftFull();
    const c=APP.lastCalc, uid=APP.user?.uid; if(!uid) return;
    const elapsed=APP.shiftStart?(Date.now()-APP.shiftStart)/60000:0;
    const sh={...c,durationMin:elapsed,date:today()};
    try {
      if(navigator.onLine){ await dbSaveShift(uid,sh); APP.piggyTotal=c.piggyTotal; toast('✅ Turno guardado!'); }
      else{ LS.addPending(uid,sh); APP.piggyTotal+=c.piggyShift; toast('📶 Offline. Sincroniza quando houver rede.'); }
    } catch{ LS.addPending(uid,sh); toast('⚠ Guardado localmente.'); }
    APP.shifts.unshift({id:Date.now().toString(),...sh});
    LS.save(uid,'shifts',APP.shifts);
    /* Reset */
    APP.shiftRunning=false; clearInterval(APP.shiftTimer);
    setText('chrono-disp','00:00:00'); setText('chrono-st','Turno parado');
    $('btn-shift-start')?.classList.remove('hidden'); $('btn-shift-stop')?.classList.add('hidden');
    $('close-shift-card')?.classList.add('hidden'); $('shift-summary')?.classList.add('hidden');
    $('btn-save-shift')?.classList.add('hidden'); $('btn-wa-shift')?.classList.add('hidden');
    ['km-start','km-end','fuel-cost'].forEach(id=>{const e=$(id);if(e)e.value='';});
    APP.lastCalc=null; APP.todayTrips=[]; LS.save(uid,`trips_${today()}`,[]);
    LS.save(uid,'active_shift',null);
    renderTrips(); updateDash(); vibrate([50,100,50]);
  });

  $('btn-wa-shift')?.addEventListener('click',()=>{ if(!APP.lastCalc) calcShiftFull(); window.open('https://wa.me/?text='+buildWAMsg(APP.lastCalc),'_blank'); });
  $('btn-wa-report')?.addEventListener('click',()=>{
    const m=APP.shifts.filter(s=>s.date?.startsWith(thisM()));
    if(!m.length){toast('Sem dados.');return;}
    const n=m.reduce((a,s)=>a+(s.lucroReal||0),0),km=m.reduce((a,s)=>a+(s.kmTotal||0),0),h=m.reduce((a,s)=>a+(s.durationMin||0)/60,0);
    const months=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const now=new Date();
    window.open('https://wa.me/?text='+encodeURIComponent(`📊 *KmLucro — ${months[now.getMonth()]} ${now.getFullYear()}*\n──────────\nTurnos: ${m.length}\n💰 Lucro Real: *${fmt(n)}*\n🛣 Km: ${km.toFixed(1)} · ⏳ ${h.toFixed(1)}h\n📈 €/hora: ${fmt(h>0?n/h:0)}\n_via KmLucro.pt_`),'_blank');
  });

  $('btn-calc-km')?.addEventListener('click', calcKm);
  $('btn-calc-irs')?.addEventListener('click', calcIRS);
  $('btn-compare')?.addEventListener('click',()=>{
    const g=parseFloat($('comp-gross').value)||0;
    setText('cmp-uber',fmt(g*(1-PLATAFORMA_TAXA)));
    setText('cmp-bolt',fmt(g*(1-BOLT_TAXA)));
    setText('cmp-out', fmt(g*(1-OUTROS_TAXA)));
    $('cmp-res')?.classList.remove('hidden');
  });

  $('drv-pct')?.addEventListener('input',function(){const v=Math.min(100,Math.max(0,parseInt(this.value)||0));$('flt-pct').value=100-v;});
  $('btn-save-config')?.addEventListener('click', async()=>{ APP.driverPct=parseInt($('drv-pct').value)||40; if(APP.user) await dbUpdateProfile(APP.user.uid,{driverPct:APP.driverPct}); toast('✓ Configuração guardada!'); });

  $('btn-add-vehicle')?.addEventListener('click',()=>openModal('modal-vehicle'));
  ['mv-close','mv-back'].forEach(id=>$(id)?.addEventListener('click',()=>closeModal('modal-vehicle')));
  $('btn-save-vehicle')?.addEventListener('click', async()=>{
    const plate=($('v-plate').value||'').trim().toUpperCase(), model=($('v-model').value||'').trim();
    if(!plate||!model){toast('⚠ Matrícula e modelo obrigatórios.');return;}
    const v={plate,model,driver:$('v-driver').value.trim(),km:parseFloat($('v-km').value)||0,svcKm:parseFloat($('v-svc-km').value)||0,alvara:$('v-alvara').value,insurance:$('v-insurance').value};
    if(APP.user){try{await dbSaveVehicle(APP.user.uid,v);APP.vehicles=await dbGetVehicles(APP.user.uid);}catch{APP.vehicles.push({id:Date.now().toString(),...v});}}
    closeModal('modal-vehicle'); renderFleet(); toast('✓ Veículo adicionado!');
    ['v-plate','v-model','v-driver','v-km','v-svc-km','v-alvara','v-insurance'].forEach(id=>{const e=$(id);if(e)e.value='';});
  });

  $('btn-add-alert')?.addEventListener('click',()=>openModal('modal-alert'));
  ['ma-close','ma-back'].forEach(id=>$(id)?.addEventListener('click',()=>closeModal('modal-alert')));
  $('btn-save-alert')?.addEventListener('click', async()=>{
    const desc=($('alert-desc').value||'').trim(), date=$('alert-date').value;
    if(!desc||!date){toast('⚠ Descrição e data obrigatórios.');return;}
    const al={desc,date,prio:$('alert-prio').value};
    if(APP.user){try{await dbSaveAlert(APP.user.uid,al);APP.alerts=await dbGetAlerts(APP.user.uid);}catch{APP.alerts.push({id:Date.now().toString(),...al});APP.alerts.sort((a,b)=>(a.date||'').localeCompare(b.date||''));}}
    closeModal('modal-alert'); renderAlertsList(); toast('✓ Alerta adicionado!');
    $('alert-desc').value=''; $('alert-date').value='';
  });

  $('btn-edit-goal')?.addEventListener('click',()=>{ if($('goal-input'))$('goal-input').value=APP.goalAmount; openModal('modal-goal'); });
  ['mg-close','mg-back'].forEach(id=>$(id)?.addEventListener('click',()=>closeModal('modal-goal')));
  $('btn-save-goal')?.addEventListener('click', async()=>{ APP.goalAmount=Math.max(1,parseFloat($('goal-input').value)||100); if(APP.user) await dbUpdateProfile(APP.user.uid,{goalAmount:APP.goalAmount}); closeModal('modal-goal'); updateDash(); toast('✓ Meta guardada!'); });

  $('btn-export-csv')?.addEventListener('click',()=>exportCSV($('rep-start').value||null,$('rep-end').value||null));
}

/* ── INSTALL PWA ─────────────────────────────────────────────── */
function bindInstall() {
  let prompt;
  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); prompt=e; setTimeout(()=>$('install-bar')?.classList.remove('hidden'),5000); });
  $('btn-install')?.addEventListener('click', async()=>{ if(!prompt) return; prompt.prompt(); await prompt.userChoice; prompt=null; $('install-bar')?.classList.add('hidden'); });
  $('btn-dismiss-install')?.addEventListener('click',()=>$('install-bar')?.classList.add('hidden'));
}

/* ── GLOBAIS (onclick inline) ────────────────────────────────── */
window._delTrip = i => {
  APP.todayTrips.splice(i,1);
  if(APP.user) LS.save(APP.user.uid,`trips_${today()}`,APP.todayTrips);
  renderTrips(); updateDash(); vibrate(20);
};
window._delAlert = async id => {
  if(!APP.user) return;
  try{ await dbDelAlert(APP.user.uid,id); }catch{}
  APP.alerts=APP.alerts.filter(a=>a.id!==id);
  renderAlertsList(); toast('Alerta removido.');
};
window._delVehicle = async id => {
  if(!confirm('Remover este veículo?')||!APP.user) return;
  try{ await dbDelVehicle(APP.user.uid,id); }catch{}
  APP.vehicles=APP.vehicles.filter(v=>v.id!==id);
  renderFleet(); toast('Veículo removido.');
};
