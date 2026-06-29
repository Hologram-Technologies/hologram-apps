(()=>{
  const side=document.querySelector('#pane-side');
  if(!side) return {pane:false, title:document.title};
  const cands={
    listitem: side.querySelectorAll('[role="listitem"]').length,
    gridcell: side.querySelectorAll('[role="gridcell"]').length,
    row: side.querySelectorAll('[role="row"]').length,
    titles: side.querySelectorAll('span[title]').length
  };
  // ancestry of the first chat-name span → reveals the clickable list-item + a usable selector
  const t=side.querySelector('span[title]');
  let sketch=null;
  if(t){ let el=t, chain=[]; for(let i=0;i<7&&el&&el!==side;i++){ const cls=(el.className&&el.className.baseVal!==undefined)?el.className.baseVal:(el.className||''); chain.push({tag:el.tagName, role:(el.getAttribute&&el.getAttribute('role'))||null, hasTabindex:el.hasAttribute&&el.hasAttribute('tabindex'), clsHead:String(cls).slice(0,30)}); el=el.parentElement; } sketch={chain}; }
  return {pane:true, cands, sketch};
})()
