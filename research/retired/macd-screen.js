#!/usr/bin/env node
// Multi-timeframe MACD screen:
//   per timeframe (Daily, Weekly, Monthly), MACD(12,26,9):
//     RISING  = macd[-1] > macd[-2]
//     BULL    = macd[-1] > signal[-1]
//     FROMNEG = macd was < 0 within the last 5 bars (rise started below zero)
//   plus daily close > SMA200.
//   STRICT  = all 3 TFs: RISING+BULL+FROMNEG
//   RELAXED = all 3 TFs RISING+BULL; FROMNEG required on Weekly & Monthly only
const fs=require('fs'),path=require('path');
const CACHE='/Users/dominiczhao/portfolio-dashboard/.backtest-cache';

function ema(a,n){const k=2/(n+1);const out=[];let e=a.slice(0,n).reduce((x,y)=>x+y,0)/n;for(let i=0;i<a.length;i++){e=i<n?(i===n-1?e:a.slice(0,i+1).reduce((x,y)=>x+y,0)/(i+1)):a[i]*k+e*(1-k);out.push(e);}return out;}
function macd(closes){if(closes.length<40)return null;const e12=ema(closes,12),e26=ema(closes,26);const m=closes.map((_,i)=>e12[i]-e26[i]);const s=ema(m.slice(25),9);const sig=new Array(25).fill(null).concat(s);return {m,sig};}
function tfState(closes){
  const r=macd(closes); if(!r)return null;
  const n=closes.length, m=r.m, sig=r.sig;
  const rising=m[n-1]>m[n-2], bull=sig[n-1]!=null&&m[n-1]>sig[n-1];
  let fromNeg=false; for(let i=Math.max(0,n-6);i<n;i++) if(m[i]<0){fromNeg=true;break;}
  return {rising,bull,fromNeg,val:m[n-1]};
}
const weekly=rows=>{const o={};rows.forEach(([d,c])=>{const dt=new Date(d);const y=dt.getUTCFullYear();const onejan=new Date(Date.UTC(y,0,1));const wk=Math.ceil((((dt-onejan)/86400000)+onejan.getUTCDay()+1)/7);o[y+'-'+wk]=c;});return Object.values(o);};
const monthly=rows=>{const o={};rows.forEach(([d,c])=>o[d.slice(0,7)]=c);return Object.values(o);};
function screen(sym,rows,cls){
  if(!rows||rows.length<420)return null; // need ~2y daily minimum; monthly needs long history
  rows.sort((a,b)=>a[0]<b[0]?-1:1);
  const closes=rows.map(x=>x[1]);
  const n=closes.length, price=closes[n-1];
  const sma200=closes.slice(-200).reduce((a,b)=>a+b,0)/200;
  const D=tfState(closes), W=tfState(weekly(rows)), M=tfState(monthly(rows));
  if(!D||!W||!M)return null;
  const above200=price>sma200;
  const upAll=D.rising&&D.bull&&W.rising&&W.bull&&M.rising&&M.bull;
  const strict=above200&&upAll&&D.fromNeg&&W.fromNeg&&M.fromNeg;
  const relaxed=above200&&upAll&&W.fromNeg&&M.fromNeg;
  return {sym,cls,price,sma200,pctAbove:(price/sma200-1)*100,D,W,M,strict,relaxed,last:rows[n-1][0]};
}
const loadCache=s=>{
  const f1=path.join(CACHE,s.replace(/[^A-Za-z0-9.-]/g,'_')+'_max.json'), f2=path.join(CACHE,s.replace(/[^A-Za-z0-9.-]/g,'_')+'.json');
  const seen={},out=[];
  for(const f of [f1,f2]) if(fs.existsSync(f)) JSON.parse(fs.readFileSync(f,'utf8')).forEach(r=>{if(!seen[r[0]]){seen[r[0]]=1;out.push(r);}});
  return out.length?out:null;
};
async function coinbase(prod){
  const out={},DAY=86400,now=Math.floor(Date.now()/1000);
  let t0=now-Math.floor(6.2*365.25)*DAY;
  while(t0<now){
    const t1=Math.min(t0+299*DAY,now);
    try{const r=await fetch(`https://api.exchange.coinbase.com/products/${prod}/candles?granularity=86400&start=${new Date(t0*1000).toISOString()}&end=${new Date(t1*1000).toISOString()}`,{headers:{'User-Agent':'scan'},signal:AbortSignal.timeout(15000)});
      if(r.ok)(await r.json()).forEach(c=>out[new Date(c[0]*1000).toISOString().slice(0,10)]=c[4]);}catch(e){}
    t0=t1+DAY; await new Promise(r=>setTimeout(r,250));
  }
  const rows=Object.entries(out); return rows.length>400?rows:null;
}
async function forex(){
  try{
    const to='EUR,JPY,GBP,AUD,NZD,CAD,CHF,SGD,CNY';
    const r=await fetch(`https://api.frankfurter.app/2015-01-01..?from=USD&to=${to}`,{signal:AbortSignal.timeout(30000)});
    if(!r.ok) return {};
    const j=await r.json(); const dates=Object.keys(j.rates).sort();
    const series=k=>dates.map(d=>[d,j.rates[d][k]]).filter(x=>x[1]!=null);
    const inv=rows=>rows.map(([d,v])=>[d,1/v]);
    const div=(a,b)=>{const m={};b.forEach(([d,v])=>m[d]=v);return a.filter(([d])=>m[d]).map(([d,v])=>[d,v/m[d]]);};
    return {
      'EUR/USD':inv(series('EUR')), 'GBP/USD':inv(series('GBP')), 'AUD/USD':inv(series('AUD')), 'NZD/USD':inv(series('NZD')),
      'USD/JPY':series('JPY'), 'USD/CAD':series('CAD'), 'USD/CHF':series('CHF'), 'USD/SGD':series('SGD'), 'USD/CNY':series('CNY'),
      'EUR/JPY':div(series('JPY'),series('EUR')), 'GBP/JPY':div(series('JPY'),series('GBP')), 'EUR/GBP':div(series('GBP'),series('EUR')),
    };
  }catch(e){return {};}
}
(async()=>{
  const results=[];
  // 1) cached instrument universe (equity/sector/region/commodity/RE ETFs + crypto majors)
  const ETFS={SPY:'US equity',QQQ:'US equity',IWM:'US equity',EFA:'Intl equity',EEM:'EM equity',VGK:'Europe',EWJ:'Japan',INDA:'India',FXI:'China',MTUM:'US factor',QUAL:'US factor',USMV:'US factor',VLUE:'US factor',XLK:'Sector',SMH:'Semis',XLF:'Sector',XLE:'Sector',XLV:'Sector',XLI:'Sector',XLU:'Sector',XLP:'Sector',XLY:'Sector',GLD:'Commodity',SLV:'Commodity',DBC:'Commodity',USO:'Commodity',URA:'Uranium',COPX:'Copper',DBA:'Agri',REMX:'RareEarth',MP:'RareEarth',UUUU:'RareEarth',USAR:'RareEarth','LYC.AX':'RareEarth','NEO.TO':'RareEarth','ILU.AX':'RareEarth','6680.HK':'RareEarth China','TLT':'Bonds',IEF:'Bonds',SHY:'Bonds',TIP:'Bonds',LQD:'Credit',HYG:'Credit',EMB:'Credit',BND:'Bonds'};
  for(const [t,cls] of Object.entries(ETFS)){ const rows=loadCache(t); const s=rows&&screen(t,rows,cls); if(s)results.push(s); }
  // 2) crypto via Coinbase (live)
  for(const c of ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','LTC','DOT','ATOM','UNI','NEAR','SUI','APT','BCH']){
    const rows=await coinbase(c+'-USD'); const s=rows&&screen(c+'-USD',rows,'Crypto'); if(s)results.push(s);
  }
  // 3) forex via ECB/frankfurter (daily fix, live)
  const fx=await forex();
  for(const [p,rows] of Object.entries(fx)){ const s=rows&&rows.length>420&&screen(p,rows,'Forex'); if(s)results.push(s); }
  if(process.env.DIAG){
    const flag=(x,f)=>x?f:f.toLowerCase();
    console.log('SYM        CLASS           >200DMA  D[rise/bull/neg]  W[rise/bull/neg]  M[rise/bull/neg]  Mval');
    results.sort((a,b)=>(b.price>b.sma200)-(a.price>a.sma200)).forEach(r=>{
      console.log(r.sym.padEnd(10)+r.cls.padEnd(15)+' '+(r.price>r.sma200?'YES':'no ').padEnd(8)
        +[r.D,r.W,r.M].map(t=>'['+flag(t.rising,'R')+flag(t.bull,'B')+flag(t.fromNeg,'N')+']').join('             ')
        +'  '+r.M.val.toFixed(3));});
  }
  const fmt=s=>`${s.sym.padEnd(9)} ${s.cls.padEnd(15)} +${s.pctAbove.toFixed(1).padStart(5)}% vs 200DMA | D:${s.D.val<0?'−':'+'}${s.D.rising?'↑':'↓'} W:${s.W.val<0?'−':'+'}${s.W.rising?'↑':'↓'} M:${s.M.val<0?'−':'+'}${s.M.rising?'↑':'↓'} | data→${s.last}`;
  console.log('==== STRICT (D+W+M rising, above signal, from below zero on ALL; price>200DMA) ====');
  const st=results.filter(r=>r.strict); console.log(st.length?st.map(fmt).join('\n'):'(none)');
  console.log('\n==== RELAXED (all TFs rising+bullish; from-below-zero on W & M; price>200DMA) ====');
  const rx=results.filter(r=>r.relaxed&&!r.strict); console.log(rx.length?rx.map(fmt).join('\n'):'(none)');
  console.log('\n==== NEAR-MISSES (price>200DMA, W&M rising from below zero, daily not yet aligned) ====');
  const nm=results.filter(r=>!r.relaxed&&!r.strict&&r.price>r.sma200&&r.W.rising&&r.W.fromNeg&&r.M.rising&&r.M.fromNeg);
  console.log(nm.length?nm.map(fmt).join('\n'):'(none)');
  console.log(`\nScanned ${results.length} instruments with sufficient history.`);
})();
