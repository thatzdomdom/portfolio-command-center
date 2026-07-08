#!/usr/bin/env node
// Backtest of the Opportunity Matrix STRONG BUY engine.
// Replicates buildModel() from index.html EXACTLY (same constants, same score,
// same >=70 STRONG BUY threshold, same RISK-OFF override) with two disclosed
// deviations: (1) macro/smart-money/research tilts are set to 0 — they cannot
// be reconstructed historically; (2) adjusted closes are used (dividends
// included) so multi-year returns are honest, esp. for bond ETFs.
// Strategy: monthly (21 trading day) rebalance into the STRONG BUY set.
// Idle cash earns 3%/yr. Costs: 10bps per side on turnover (net results).
const fs = require('fs'), path = require('path');

const UNIVERSE = [ // {t, prior, cap} — identical to MODEL_UNIVERSE in index.html
  ['SPY',.07,.20],['QQQ',.08,.22],['IWM',.07,.22],['EFA',.06,.18],['EEM',.07,.22],['VGK',.06,.18],['EWJ',.06,.18],['INDA',.08,.24],['FXI',.07,.28],
  ['MTUM',.07,.20],['QUAL',.07,.18],['USMV',.06,.14],['VLUE',.06,.20],['XLK',.08,.24],['SMH',.10,.32],['XLF',.07,.22],['XLE',.05,.26],['XLV',.06,.16],['XLI',.07,.20],['XLU',.05,.16],['XLP',.05,.14],['XLY',.07,.22],
  ['GLD',.045,.18],['SLV',.05,.30],['DBC',.03,.16],['USO',.02,.34],['URA',.08,.40],['COPX',.05,.34],['DBA',.02,.18],
  ['BTC-USD',.25,.80],['ETH-USD',.25,.90],['SOL-USD',.30,1.0],
  ['TLT',.035,.16],['IEF',.03,.10],['SHY',.025,.05],['TIP',.03,.10],['LQD',.035,.12],['HYG',.05,.14],['EMB',.05,.14],['BND',.03,.08],
  ['REMX',.07,.34],['MP',.10,.45],['LYC.AX',.08,.40],['UUUU',.08,.45],['USAR',.10,.55],['NEO.TO',.08,.40],['ILU.AX',.06,.35],['6680.HK',.08,.45]
].map(([t,prior,cap])=>({t,prior,cap}));

// EXCLUDE=RE  → drop the 2026-added rare-earth names (selection-bias check)
// EXCLUDE=RE,CRYPTO → also drop crypto
if (process.env.EXCLUDE) {
  const ex = process.env.EXCLUDE.split(',');
  const RE = ['REMX','MP','LYC.AX','UUUU','USAR','NEO.TO','ILU.AX','6680.HK'];
  const CR = ['BTC-USD','ETH-USD','SOL-USD'];
  const drop = new Set([...(ex.includes('RE')?RE:[]), ...(ex.includes('CRYPTO')?CR:[])]);
  for (let i = UNIVERSE.length - 1; i >= 0; i--) if (drop.has(UNIVERSE[i].t)) UNIVERSE.splice(i, 1);
}
const CACHE = path.join(__dirname, '..', '.backtest-cache');
fs.mkdirSync(CACHE, { recursive: true });
const clip=(x,a,b)=>Math.max(a,Math.min(b,x));
function normCdf(x){const t=1/(1+0.2316419*Math.abs(x)),d=0.3989422804014327*Math.exp(-x*x/2);let p=d*t*(0.31938153+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>0?1-p:p;}

async function fetchHist(sym){
  const f=path.join(CACHE, sym.replace(/[^A-Za-z0-9.-]/g,'_')+'.json');
  if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10y`;
  const tries=[`https://corsproxy.io/?url=${encodeURIComponent(url)}`,`https://api.codetabs.com/v1/proxy/?quest=${url}`,url];
  for(const u of tries){
    try{
      const r=await fetch(u,{headers:{'Origin':'https://thatzdomdom.github.io','User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'},signal:AbortSignal.timeout(20000)});
      if(!r.ok) continue;
      const j=await r.json(); const res=j&&j.chart&&j.chart.result&&j.chart.result[0]; if(!res) continue;
      const ts=res.timestamp||[], adj=(res.indicators.adjclose&&res.indicators.adjclose[0].adjclose)||[], raw=(res.indicators.quote&&res.indicators.quote[0].close)||[];
      const out=[];
      for(let i=0;i<ts.length;i++){const c=(adj[i]!=null?adj[i]:raw[i]); if(c!=null&&c>0) out.push([new Date(ts[i]*1000).toISOString().slice(0,10), c]);}
      if(out.length>100){ fs.writeFileSync(f,JSON.stringify(out)); return out; }
    }catch(e){}
    await new Promise(r=>setTimeout(r,700));
  }
  return null;
}

// EXACT port of the quant half of buildModel() (tilts=0)
function scoreAt(C){ // C = array of closes up to and including decision day
  const n=C.length; if(n<60) return null;
  const price=C[n-1];
  const sma=k=>{const s=C.slice(Math.max(0,n-k));return s.reduce((a,b)=>a+b,0)/s.length;};
  const sma50=sma(50), sma200=sma(200);
  const logR=[]; for(let i=Math.max(1,n-253);i<n;i++) logR.push(Math.log(C[i]/C[i-1]));
  const std=a=>{if(a.length<2)return 0;const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/(a.length-1));};
  const vol90=std(logR.slice(-90))*Math.sqrt(252), vol252=std(logR)*Math.sqrt(252);
  let sigma=0.6*vol90+0.4*vol252; if(!(sigma>0)) sigma=0.05; sigma=Math.max(sigma,0.04);
  const dr=w=>{const a=logR.slice(-w);return a.length?a.reduce((x,y)=>x+y,0)/a.length*252:0;};
  const drift252=dr(252);
  const px=k=>C[Math.max(0,n-1-k)];
  const mom12_1=n>252?px(21)/px(252)-1:(n>40?price/px(Math.min(n-1,Math.floor(n*0.5)))-1:0);
  let g=0,l=0; const w=Math.min(14,n-1); for(let i=n-w;i<n;i++){const ch=C[i]-C[i-1];if(ch>=0)g+=ch;else l-=ch;}
  const t200=clip((price/sma200-1)/0.12,-1,1), t50=clip((sma50/sma200-1)/0.06,-1,1), momS=clip(mom12_1/0.20,-1,1);
  const Slong=0.45*t200+0.30*momS+0.25*t50;
  return {price,sigma,drift252,Slong,sma50,sma200};
}
function labelAt(C,u){
  const b=scoreAt(C); if(!b) return null;
  const muLong=clip(0.30*b.drift252+0.50*u.prior+0.10*b.Slong,-u.cap,u.cap); // tilts=0 (disclosed)
  const hz=T=>{const mLog=(muLong-0.5*b.sigma*b.sigma)*T,s=b.sigma*Math.sqrt(T);return clip(normCdf(mLog/s),0.05,0.95);};
  const p3=hz(63/252), p12=hz(1);
  const sharpe=(muLong-0.04)/b.sigma;
  const down=b.price<b.sma200&&b.sma50<b.sma200;
  const raw=0.35*((p3-0.5)/0.5)+0.25*((p12-0.5)/0.5)+0.20*clip(sharpe,-1,1)+0.20*b.Slong;
  const score=clip(50+50*raw,0,100);
  const riskOff=down&&muLong<0;
  const strongBuy=score>=70&&!riskOff;
  return {score,strongBuy,riskOff,sigma:b.sigma};
}

(async()=>{
  console.log('Fetching 10y adjusted history for', UNIVERSE.length, 'instruments…');
  const hist={};
  for(const u of UNIVERSE){ const h=await fetchHist(u.t); if(h) hist[u.t]=h; else console.log('  !! no data:',u.t); await new Promise(r=>setTimeout(r,250)); }
  console.log('Got', Object.keys(hist).length, 'series.');
  // master calendar = SPY dates; per-symbol date→index maps
  const cal=hist['SPY'].map(x=>x[0]);
  const map={}; for(const t in hist){ map[t]={}; hist[t].forEach(([d,c],i)=>map[t][d]=i); }
  const closesUpTo=(t,d)=>{const i=map[t][d]; return i==null?null:hist[t].slice(0,i+1).map(x=>x[1]);};
  const priceOn=(t,d)=>{const i=map[t][d]; return i==null?null:hist[t][i][1];};
  const START=cal.findIndex(d=>d>='2017-07-01'); // 1y of warm-up on 10y data
  const RF_D=0.03/252, COST=0.001; // 3% cash yield, 10bps per side
  const variants={ 'SB-EW (STRONG BUY, equal-wt)':{sel:'sb',iv:false}, 'SB-IV (STRONG BUY, inverse-vol)':{sel:'sb',iv:true}, 'B60-EW (score>=60, equal-wt)':{sel:'b60',iv:false} };
  const results={};
  for(const [name,cfg] of Object.entries(variants)){
    let V=1, weights={}, eq=[], picksLog=[], countSum=0, countN=0, tradedDays=0;
    for(let i=START;i<cal.length-1;i++){
      const d=cal[i];
      const isReb=((i-START)%21===0);
      if(isReb){
        const picks=[];
        for(const u of UNIVERSE){ const C=closesUpTo(u.t,d); if(!C) continue; const L=labelAt(C,u); if(!L) continue;
          if((cfg.sel==='sb'&&L.strongBuy)||(cfg.sel==='b60'&&L.score>=60&&!L.riskOff)) picks.push({t:u.t,sigma:L.sigma,score:L.score}); }
        const sel=picks;
        let nw={};
        if(sel.length){ if(cfg.iv){ const ivs=sel.map(p=>1/Math.max(p.sigma,0.05)); const s=ivs.reduce((a,b)=>a+b,0); sel.forEach((p,k)=>nw[p.t]=ivs[k]/s); } else sel.forEach(p=>nw[p.t]=1/sel.length); }
        // turnover cost
        const keys=new Set([...Object.keys(weights),...Object.keys(nw)]);
        let turn=0; keys.forEach(k=>turn+=Math.abs((nw[k]||0)-(weights[k]||0)));
        V*=(1-turn*COST);
        weights=nw; countSum+=sel.length; countN++;
        picksLog.push({d,n:sel.length,picks:sel.map(p=>p.t)});
      }
      // one-day P&L d -> d+1 (weights drift within the month)
      const d2=cal[i+1]; let ret=0, invested=0, nw2={};
      for(const t in weights){ const p1=priceOn(t,d), p2=priceOn(t,d2); const w=weights[t];
        if(p1&&p2){ ret+=w*(p2/p1-1); invested+=w; nw2[t]=w*(p2/p1); } else { ret+=0; invested+=w; nw2[t]=w; } }
      ret+=(1-invested)*RF_D;
      V*=(1+ret);
      const tot=Object.values(nw2).reduce((a,b)=>a+b,0)+(1-invested);
      for(const t in nw2) nw2[t]/=tot; weights=nw2;
      eq.push([d2,V]);
    }
    // metrics
    const rets=[]; for(let i=1;i<eq.length;i++) rets.push(eq[i][1]/eq[i-1][1]-1);
    const yrs=(eq.length)/252, cagr=Math.pow(V,1/yrs)-1;
    const m=rets.reduce((a,b)=>a+b,0)/rets.length, vol=Math.sqrt(rets.reduce((s,r)=>s+(r-m)*(r-m),0)/(rets.length-1))*Math.sqrt(252);
    let peak=1,mdd=0,ddStart='',ddDate=''; let pk=eq[0][0];
    for(const [d,v] of eq){ if(v>peak){peak=v;pk=d;} const dd=v/peak-1; if(dd<mdd){mdd=dd;ddStart=pk;ddDate=d;} }
    // yearly
    const byY={}; eq.forEach(([d,v])=>{const y=d.slice(0,4); byY[y]=byY[y]||{first:v,last:v}; byY[y].last=v;});
    const years=Object.keys(byY).sort(); const yr={}; let prev=1;
    years.forEach(y=>{ yr[y]=byY[y].last/prev-1; prev=byY[y].last; });
    results[name]={final:V,cagr,vol,sharpe:(cagr-0.03)/vol,maxDD:mdd,ddStart,ddDate,avgHoldings:countSum/countN,yearly:yr,picksLog};
  }
  // SPY benchmark over the identical window
  {
    const s=cal.slice(START).map(d=>priceOn('SPY',d)); const eqS=s.map(p=>p/s[0]);
    const rets=[]; for(let i=1;i<eqS.length;i++) rets.push(eqS[i]/eqS[i-1]-1);
    const yrs=eqS.length/252, cagr=Math.pow(eqS[eqS.length-1],1/yrs)-1;
    const m=rets.reduce((a,b)=>a+b,0)/rets.length, vol=Math.sqrt(rets.reduce((x,r)=>x+(r-m)*(r-m),0)/(rets.length-1))*Math.sqrt(252);
    let peak=0,mdd=0; for(const v of eqS){ if(v>peak)peak=v; mdd=Math.min(mdd,v/peak-1); }
    const byY={}; cal.slice(START).forEach((d,i)=>{const y=d.slice(0,4); byY[y]=byY[y]||{first:eqS[i]}; byY[y].last=eqS[i];});
    const years=Object.keys(byY).sort(); const yr={}; let prev=1; years.forEach(y=>{yr[y]=byY[y].last/prev-1; prev=byY[y].last;});
    results['SPY buy & hold (benchmark)']={final:eqS[eqS.length-1],cagr,vol,sharpe:(cagr-0.03)/vol,maxDD:mdd,avgHoldings:1,yearly:yr};
  }
  fs.writeFileSync(path.join(CACHE,'results.json'),JSON.stringify(results,null,1));
  for(const [name,r] of Object.entries(results)){
    console.log(`\n== ${name} ==`);
    console.log(`  Total ×${r.final.toFixed(2)} · CAGR ${(r.cagr*100).toFixed(1)}% · Vol ${(r.vol*100).toFixed(1)}% · Sharpe(3%) ${r.sharpe.toFixed(2)} · MaxDD ${(r.maxDD*100).toFixed(1)}%${r.ddDate?` (trough ${r.ddDate}, from peak ${r.ddStart})`:''} · avg holdings ${r.avgHoldings.toFixed(1)}`);
    console.log('  yearly: '+Object.entries(r.yearly).map(([y,v])=>`${y} ${(v*100).toFixed(0)}%`).join(' · '));
  }
  console.log('\nFull results + monthly pick logs → .backtest-cache/results.json');
})();
