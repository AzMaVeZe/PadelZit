// Public read-only results page (r.html?t=<id>).
//
// SECURITY: everything rendered here comes from a row anyone can write
// (publish_live is open to anonymous callers), so the payload is treated as
// hostile. normalize() rebuilds a minimal, typed copy — strings for names,
// finite integers for every number, in-range player indexes — and nothing
// else from the payload ever reaches the page. Names still go through esc().
'use strict';
const SB = 'https://axrugdszycwmadbdwolx.supabase.co';
const KEY = 'sb_publishable_DJKbYBC-m4TcUbM2D1gSlQ_WQfJW-1m';
const POLL_MS = 5000;
const MAX_PLAYERS = 12;
const MAX_GAMES = 500;
let timer = null;
let everRendered = false;

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function int(v){const n=Math.trunc(Number(v));return Number.isFinite(n)?Math.max(-100000,Math.min(100000,n)):0;}

// Team = array of distinct in-range player indexes (1–2 entries).
function team(v,n){
  if(!Array.isArray(v)) return null;
  const out=[];
  for(const x of v){const i=Number(x);if(Number.isInteger(i)&&i>=0&&i<n&&!out.includes(i))out.push(i);}
  return out.length&&out.length<=2?out:null;
}
function matchup(v,n){
  if(!Array.isArray(v)||v.length!==2) return null;
  const a=team(v[0],n),b=team(v[1],n);
  return a&&b?[a,b]:null;
}

function normalize(raw){
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.players)) return null;
  const players=raw.players.slice(0,MAX_PLAYERS).map(p=>String(p==null?'':p).slice(0,40));
  const n=players.length;
  if(n<2) return null;
  const history=(Array.isArray(raw.history)?raw.history.slice(0,MAX_GAMES):[]).map(g=>{
    if(!g||typeof g!=='object') return null;
    const a=team(g.teamA,n),b=team(g.teamB,n);
    return a&&b?{teamA:a,teamB:b,scoreA:int(g.scoreA),scoreB:int(g.scoreB)}:null;
  }).filter(Boolean);
  // Recompute standings from the game list instead of trusting stored totals.
  const points=new Array(n).fill(0),gamesWon=new Array(n).fill(0),gamesPlayed=new Array(n).fill(0);
  history.forEach(g=>{
    g.teamA.forEach(i=>{points[i]+=g.scoreA;gamesPlayed[i]++;if(g.scoreA>g.scoreB)gamesWon[i]++;});
    g.teamB.forEach(i=>{points[i]+=g.scoreB;gamesPlayed[i]++;if(g.scoreB>g.scoreA)gamesWon[i]++;});
  });
  return {
    players,history,points,gamesWon,gamesPlayed,
    finished:raw.finished===true,
    format:raw.format==='mexicano'?'mexicano':'americano',
    createdAt:int(raw.createdAt),
    next:matchup(raw.next,n),
    next2:matchup(raw.next2,n),
  };
}

function diffOf(t,i){let d=0;t.history.forEach(g=>{if(g.teamA.includes(i))d+=g.scoreA-g.scoreB;else if(g.teamB.includes(i))d+=g.scoreB-g.scoreA;});return d;}
function rankOrder(t){
  return [...Array(t.players.length).keys()].sort((x,y)=>t.points[y]-t.points[x]||t.gamesWon[y]-t.gamesWon[x]||diffOf(t,y)-diffOf(t,x));
}
// Competition ranking: players tied on points, wins and +/- share a rank (1,1,3).
function ranks(t,order){
  const out={};let prevKey=null,prevRank=0;
  order.forEach((i,idx)=>{const key=t.points[i]+'/'+t.gamesWon[i]+'/'+diffOf(t,i);const r=key===prevKey?prevRank:idx+1;out[i]=r;prevKey=key;prevRank=r;});
  return out;
}

function table(t,title){
  const order=rankOrder(t),rk=ranks(t,order);
  let h='<div class="card"><h2>'+title+'</h2><table><thead><tr><th>#</th><th>שחקן</th><th class="num">נקודות</th><th class="num">נצ׳</th><th class="num">מש׳</th></tr></thead><tbody>';
  order.forEach(i=>{const r=rk[i];h+='<tr><td><span class="rank-badge rank-'+r+'">'+r+'</span></td><td>'+esc(t.players[i])+'</td><td class="num pts">'+t.points[i]+'</td><td class="num">'+t.gamesWon[i]+'</td><td class="num">'+t.gamesPlayed[i]+'</td></tr>';});
  h+='</tbody></table></div>';
  return h;
}

function renderLive(t){
  document.getElementById('live-badge').classList.add('on');
  let h='';
  if(t.next){
    const nm=i=>esc(t.players[i]);
    const match=(m,label)=>{
      const a=m[0].map(nm).join(' + '),b=m[1].map(nm).join(' + ');
      return (label?'<div class="court-cap">'+label+'</div>':'')+
        '<div class="match"><div class="team">'+a+'</div><div class="vs">נגד</div><div class="team">'+b+'</div></div>';
    };
    const two=!!t.next2;
    const onCourt=new Set([].concat(t.next[0],t.next[1],two?t.next2[0]:[],two?t.next2[1]:[]));
    const resting=[...Array(t.players.length).keys()].filter(i=>!onCourt.has(i)).map(i=>esc(t.players[i]));
    h+='<div class="card"><h2>▶ '+(two?'משחקים נוכחיים':'משחק נוכחי')+'</h2>';
    h+=match(t.next,two?'מגרש 1':'');
    if(two) h+=match(t.next2,'מגרש 2');
    if(resting.length) h+='<div class="resting">😴 נחים: '+resting.join(', ')+'</div>';
    h+='</div>';
  }
  h+=table(t,'🏆 דירוג');
  document.getElementById('content').innerHTML=h;
}

function renderFinal(t){
  document.getElementById('live-badge').classList.remove('on');
  const order=rankOrder(t),rk=ranks(t,order);
  const line=i=>t.points[i]+' נק׳ · '+t.gamesWon[i]+' נצ׳';
  const medal=i=>['🥇','🥈','🥉'][rk[i]-1]||'';
  let h='<div class="card"><h2>🎉 תוצאות הטורניר</h2>';
  h+='<div class="podium-first"><div class="medal">'+medal(order[0])+'</div><div class="name">'+esc(t.players[order[0]])+'</div><div class="score">'+line(order[0])+'</div></div>';
  h+='<div class="podium-rest">';
  for(let k=1;k<3&&k<order.length;k++) h+='<div class="p"><div class="medal">'+medal(order[k])+'</div><div class="name">'+esc(t.players[order[k]])+'</div><div class="score">'+line(order[k])+'</div></div>';
  h+='</div></div>';
  h+=table(t,'הטבלה הסופית');
  document.getElementById('content').innerHTML=h;
}

function render(t){
  const d=new Date(t.createdAt);
  if(t.createdAt&&!isNaN(d)) document.getElementById('subtitle').textContent=d.toLocaleDateString('he-IL')+(t.format==='mexicano'?' · מקסיקנו':'');
  everRendered=true;
  if(t.finished){ renderFinal(t); stop(); }
  else renderLive(t);
}

function note(msg,retry){
  const c=document.getElementById('content');
  c.textContent='';
  const div=document.createElement('div');div.className='note';div.textContent=msg;c.appendChild(div);
  if(retry){const b=document.createElement('button');b.className='retry';b.type='button';b.textContent='נסו שוב';b.addEventListener('click',()=>{note('טוען תוצאות…');start();});c.appendChild(b);}
}

async function fetchShared(id){
  const res=await fetch(SB+'/rest/v1/rpc/get_public_tournament',{
    method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},
    body:JSON.stringify({tid:id})});
  if(!res.ok) throw new Error('http');
  return res.json();
}

function stop(){if(timer){clearInterval(timer);timer=null;}}

let tid=null;
async function poll(){
  try{
    const raw=await fetchShared(tid);
    const t=normalize(raw);
    if(!t){note('התוצאות לא נמצאו או שאינן ציבוריות.');stop();return;}
    render(t);
  }catch(e){
    // Keep the last good render; only replace the first-load spinner.
    if(!everRendered){note('לא הצלחנו לטעון את התוצאות. בדקו את החיבור לאינטרנט.',true);stop();}
  }
}
function start(){stop();poll();timer=setInterval(poll,POLL_MS);}

(()=>{
  tid=new URLSearchParams(location.search).get('t');
  if(!tid||!/^[A-Za-z0-9_-]{1,64}$/.test(tid)){note('קישור לא תקין.');return;}
  start();
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) stop(); else if(!timer&&everRendered) start(); });
})();
