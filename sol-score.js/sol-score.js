/* Sol Sniper Safety Score System - v1.0 */
(function(){

/* SCORING ALGORITHM (0-100) */
window.calcSolScore=function(t){
  var l=t.liq||0,f=t.fdv||0,v=t.vol24||0,c=t.chg5m||0,a=t.age||0,s=t.source||'',d=t.dex||'',sc=0,bd={};
  var ls=l>=50000?25:l>=20000?20:l>=10000?16:l>=5000?12:l>=2000?7:l>=1000?3:0;
  bd.liq=ls;sc+=ls;
  var rs=0;if(l>0&&f>0){var r=f/l;rs=r<3?20:r<5?16:r<10?12:r<20?7:r<50?3:0;}
  bd.ratio=rs;sc+=rs;
  var vs=0;if(l>0&&v>0){var vr=v/l;vs=vr>=2?15:vr>=1?12:vr>=.5?9:vr>=.2?6:vr>=.05?3:1;}else if(v>0)vs=5;
  bd.vol=vs;sc+=vs;
  var ms=c>=1?15:c>=.5?13:c>=.2?11:c>=.1?9:c>=.05?7:c>=.01?5:c>=0?3:c>=-.05?1:0;
  bd.mom=ms;sc+=ms;
  var as=a<=0?1:a<2?3:a<10?7:a<30?10:a<60?8:5;
  bd.age=as;sc+=as;
  var ss=s==='GeckoTerminal'?10:s==='DexScreener'?7:4;
  if(d==='Raydium'||d==='Orca')ss=Math.min(ss+2,10);
  bd.src=ss;sc+=ss;
  var rp=0,fl=[];
  if(l===0||f===0){rp+=25;fl.push('No liq/FDV data');}
  if(l>0&&f>0&&f/l>100){rp+=15;fl.push('FDV/Liq >100x');}
  if(d==='PumpFun'||d==='pump.fun'||(s||'').toLowerCase().includes('pump')){rp+=5;fl.push('Pump.fun origin');}
  if(a<3&&v===0){rp+=5;fl.push('No vol <3m old');}
  if(c>2){rp+=8;fl.push('>200% 5m pump');}
  bd.rugPenalty=-rp;bd.flags=fl;sc-=rp;
  return{score:Math.max(0,Math.min(100,Math.round(sc))),breakdown:bd};
};

/* COLOR MAPPING */
window.getSolScoreClass=function(sc){
  if(sc>=70)return{cls:'sol-score-great',barColor:'#14F195',label:'GREAT'};
  if(sc>=50)return{cls:'sol-score-good',barColor:'#4ade80',label:'GOOD'};
  if(sc>=30)return{cls:'sol-score-mid',barColor:'#fbbf24',label:'MID'};
  return{cls:'sol-score-low',barColor:'#f87171',label:'RISKY'};
};

/* CSS STYLES */
var styleEl=document.createElement('style');
styleEl.id='sol-score-styles-permanent';
styleEl.textContent='.sol-score-badge{display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;letter-spacing:.3px;white-space:nowrap;line-height:1.5;cursor:help}.sol-score-low{background:rgba(239,68,68,.2);color:#f87171;border:1px solid rgba(239,68,68,.4)}.sol-score-mid{background:rgba(245,158,11,.2);color:#fbbf24;border:1px solid rgba(245,158,11,.4)}.sol-score-good{background:rgba(34,197,94,.2);color:#4ade80;border:1px solid rgba(34,197,94,.4)}.sol-score-great{background:rgba(20,241,149,.25);color:#14F195;border:1px solid rgba(20,241,149,.45)}.sol-score-outer{display:flex;align-items:center;gap:8px;margin-top:3px}.sol-score-bar-wrap{flex:1;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden}.sol-score-bar{height:100%;border-radius:2px}.sol-score-pending{font-size:10px;color:#666;font-style:italic;margin-top:3px}.sol-score-tooltip{display:none;position:fixed;background:#1a1a2e;border:1px solid rgba(153,69,255,.5);border-radius:8px;padding:10px 12px;font-size:10px;color:#b0b0cc;z-index:99999;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,.6);pointer-events:none;line-height:1.8}';
document.head.appendChild(styleEl);

/* DOM INJECTOR */
window._injectSolScores=function(tokens){
  var feed=document.querySelector('#sol-feed');if(!feed)return;
  var rows=Array.from(feed.children);
  rows.forEach(function(row,idx){
    row.querySelectorAll('.sol-score-outer,.sol-score-pending').forEach(function(el){el.remove();});
    var token=tokens&&tokens[idx]?tokens[idx]:null;if(!token)return;
    var hasData=token.liq>0||token.fdv>0;
    var infoDiv=row.children[1];if(!infoDiv)return;
    if(!hasData){infoDiv.insertAdjacentHTML('beforeend','<div class="sol-score-pending">Score pending - awaiting data</div>');return;}
    var res=window.calcSolScore(token),score=res.score,bd=res.breakdown;
    var sc=window.getSolScoreClass(score);
    var flagsHtml=bd.flags&&bd.flags.length>0?'<div style="color:#f87171;margin-top:4px">Flags: '+bd.flags.join(', ')+'</div>':'<div style="color:#4ade80;margin-top:4px">No major red flags</div>';
    var tipId='sst_'+Math.random().toString(36).substr(2,8);
    var html='<div class="sol-score-outer"><span class="sol-score-badge '+sc.cls+'" onmouseenter="var t=document.getElementById(\x27'+tipId+'\x27);t.style.display=\x27block\x27;t.style.top=Math.max(10,event.clientY-170)+\x27px\x27;t.style.left=Math.min(event.clientX+12,window.innerWidth-220)+\x27px\x27;" onmouseleave="document.getElementById(\x27'+tipId+'\x27).style.display=\x27none\x27;">'+score+'/100</span><div class="sol-score-bar-wrap"><div class="sol-score-bar" style="width:'+score+'%;background:'+sc.barColor+'"></div></div><div id="'+tipId+'" class="sol-score-tooltip"><b>Score: '+score+'/100 - '+sc.label+'</b><br>Liq:+'+bd.liq+' FDV/Liq:+'+bd.ratio+' Vol:+'+bd.vol+' Mom:+'+bd.mom+' Age:+'+bd.age+' Src:+'+bd.src+' Rug:'+bd.rugPenalty+'<br>'+flagsHtml+'</div></div>';
    infoDiv.insertAdjacentHTML('beforeend',html);
  });
};

/* POLLING LOOP (150ms) */
setInterval(function(){
  var feed=document.querySelector('#sol-feed');if(!feed)return;
  var tokens=window._solTokens;if(!tokens||!tokens.length)return;
  var rows=Array.from(feed.children);
  var needsUpdate=false;
  rows.forEach(function(row,idx){
    var token=tokens[idx];if(!token)return;
    var hasData=token.liq>0||token.fdv>0;
    if(hasData&&!row.querySelector('.sol-score-outer'))needsUpdate=true;
    if(!hasData&&!row.querySelector('.sol-score-pending'))needsUpdate=true;
  });
  if(needsUpdate)window._injectSolScores(tokens);
},150);

/* PATCH renderSolFeed */
function patchRenderSolFeed(){
  var _o=window.renderSolFeed;
  if(typeof _o==='function'){
    window.renderSolFeed=function(t){
      _o(t);
      requestAnimationFrame(function(){window._injectSolScores(t);});
    };
  }
}
patchRenderSolFeed();
document.addEventListener('DOMContentLoaded',patchRenderSolFeed);

})();
