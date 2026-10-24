#!/usr/bin/env node
// Backtests the "Bottleneck Barbell" design (fixed target weights) in three modes:
//   A. static     — monthly rebalance to targets
//   B. overlay-G  — trend overlay on the growth sleeves only (45%): a member in
//                   confirmed downtrend (price<sma200 && sma50<sma200) parks in SHY
//   C. overlay-GA — overlay on growth + asymmetry sleeves (55%)
// Costs 10bps/side on turnover. Uses .backtest-cache/*_max.json daily data.
const fs=require('fs'),path=require('path');
const CACHE=path.join(__dirname,'..','.backtest-cache');
const W={ QUAL:10, EFA:6, EEM:4, SMH:8, URA:4, XLU:3, FXI:6, INDA:4,   // growth 45
          GLD:10, COPX:3, DBC:2, SLV:5,                                  // real assets 20
          TLT:6, IEF:4, TIP:5, SHY:10,                                   // defense/income 25
          'BTC-USD':5, REMX:5 };                                         // asymmetry 10
const GROWTH=['QUAL','EFA','EEM','SMH','URA','XLU','FXI','INDA'];
const ASYM=['BTC-USD','REMX'];
const load=s=>{const f=path.join(CACHE,s.replace(/[^A-Za-z0-9.-]/g,'_')+'_max.json');return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;};
const hist={},idx={};
for(const t of [...Object.keys(W),'SPY']){const h=load(t);if(!h){console.log('missing',t);process.exit(1);}hist[t]=h;idx[t]={};h.forEach(([d,c],i)=>idx[t][d]=i);}
const cal=hist.SPY.map(x=>x[0]);
const px=(t,d)=>{const i=idx[t][d];return i==null?null:hist[t][i][1];};
const downtrend=(t,d)=>{ // same "confirmed downtrend" as the dashboard's flags
  const i=idx[t][d]; if(i==null||i<200) return false;
  const C=hist[t].slice(i-249,i+1).map(x=>x[1]); const n=C.length;
  const sma=k=>{const s=C.slice(Math.max(0,n-k));return s.reduce((a,b)=>a+b,0)/s.length;};
  return C[n-1]<sma(200)&&sma(50)<sma(200);
};
function run(start,mode){
  const days=cal.filter(d=>d>=start);
  let V=1, weights={}, eq=[], parked={};
  const overlaid=mode==='B'?GROWTH:(mode==='C'||mode==='D')?[...GROWTH,...ASYM]:[];
  for(let i=0;i<days.length-1;i++){
    const d=days[i];
    const annual=(i%252===0), monthly=(i%21===0);
    if(mode==='D'?annual:monthly){ // full rebalance to targets w/ overlay state
      const nw={}; let shy=0; parked={};
      for(const t in W){ const w=W[t]/100;
        if(px(t,d)==null){ shy+=w; continue; }                       // not listed yet → cash
        if(overlaid.includes(t)&&downtrend(t,d)){ shy+=w; parked[t]=w; continue; } // overlay: park in SHY
        nw[t]=(nw[t]||0)+w; }
      nw.SHY=(nw.SHY||0)+shy;
      const keys=new Set([...Object.keys(weights),...Object.keys(nw)]);
      let turn=0; keys.forEach(k=>turn+=Math.abs((nw[k]||0)-(weights[k]||0)));
      V*=(1-turn*0.001); weights=nw;
    } else if(mode==='D'&&monthly){ // hybrid: monthly overlay switches only, no target rebalance
      const nw={...weights};
      for(const t of overlaid){
        if(px(t,d)==null) continue;
        const isDown=downtrend(t,d);
        if(isDown&&nw[t]){ parked[t]=nw[t]; nw.SHY=(nw.SHY||0)+nw[t]; V*=(1-nw[t]*0.001); delete nw[t]; }
        else if(!isDown&&parked[t]){ const w=Math.min(parked[t],nw.SHY||0); if(w>0){ nw[t]=(nw[t]||0)+w; nw.SHY-=w; V*=(1-w*0.001);} delete parked[t]; }
      }
      weights=nw;
    }
    const d2=days[i+1]; let v2=0, nw2={};
    for(const t in weights){ const p1=px(t,d),p2=px(t,d2); const rel=(p1&&p2)?p2/p1:1; nw2[t]=weights[t]*rel; v2+=nw2[t]; }
    V*=v2; for(const t in nw2) nw2[t]/=v2; weights=nw2;
    eq.push([d2,V]);
  }
  const yrs=eq.length/252, cagr=Math.pow(V,1/yrs)-1;
  const rets=[];for(let i=1;i<eq.length;i++)rets.push(eq[i][1]/eq[i-1][1]-1);
  const m=rets.reduce((a,b)=>a+b,0)/rets.length, vol=Math.sqrt(rets.reduce((s,r)=>s+(r-m)*(r-m),0)/(rets.length-1))*Math.sqrt(252);
  let pk=0,mdd=0,tr='';for(const [d,v] of eq){if(v>pk)pk=v;const dd=v/pk-1;if(dd<mdd){mdd=dd;tr=d;}}
  return {V,cagr,vol,sharpe:(cagr-0.03)/vol,mdd,tr};
}
function spy(start){
  const days=cal.filter(d=>d>=start); const p0=px('SPY',days[0]);
  const eq=days.map(d=>[d,px('SPY',d)/p0]); const V=eq[eq.length-1][1];
  const yrs=eq.length/252, cagr=Math.pow(V,1/yrs)-1;
  const rets=[];for(let i=1;i<eq.length;i++)rets.push(eq[i][1]/eq[i-1][1]-1);
  const m=rets.reduce((a,b)=>a+b,0)/rets.length, vol=Math.sqrt(rets.reduce((s,r)=>s+(r-m)*(r-m),0)/(rets.length-1))*Math.sqrt(252);
  let pk=0,mdd=0;for(const [,v] of eq){if(v>pk)pk=v;mdd=Math.min(mdd,v/pk-1);}
  return {V,cagr,vol,sharpe:(cagr-0.03)/vol,mdd};
}
for(const start of ['2011-01-03','2015-01-02','2020-01-02']){
  console.log(`\n===== from ${start} =====`);
  const s=spy(start); console.log(`SPY        : ×${s.V.toFixed(2)} CAGR ${(s.cagr*100).toFixed(1)}% vol ${(s.vol*100).toFixed(1)}% Sharpe ${s.sharpe.toFixed(2)} MaxDD ${(s.mdd*100).toFixed(1)}%`);
  for(const [mode,label] of [['A','A static    '],['B','B overlay-G '],['C','C overlay-GA'],['D','D hybrid    ']]){
    const r=run(start,mode);
    console.log(`${label}: ×${r.V.toFixed(2)} CAGR ${(r.cagr*100).toFixed(1)}% vol ${(r.vol*100).toFixed(1)}% Sharpe ${r.sharpe.toFixed(2)} MaxDD ${(r.mdd*100).toFixed(1)}% (${r.tr})`);
  }
}
