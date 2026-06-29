(async()=>{
  // open the "Ilya" test chat (structure-only probe; no message content is returned)
  const t=[...document.querySelectorAll('span[title]')].filter(s=>(s.getAttribute('title')||'')==='Ilya')[0];
  if(t){ const r=t.closest("div[role='listitem']")||t.closest("div[role='row']")||t.parentElement; try{(r||t).click();}catch(e){} }
  await new Promise(r=>setTimeout(r,4000));
  const n=s=>{try{return document.querySelectorAll(s).length}catch(e){return 'ERR'}};
  const probe={
    main: n('#main'),
    roleRow: n("div[role='row']"),
    copyable: n('.copyable-text'),
    prePlain: n('[data-pre-plain-text]'),
    selectable: n('span.selectable-text'),
    msgInOut: n('div.message-in, div.message-out'),
    dataId: n('#main div[data-id]')
  };
  let sketch=null;
  const cap=document.querySelector('#main [data-pre-plain-text]');
  if(cap){ const row=cap.closest('div[data-id]')||cap.closest("div[role='row']")||cap;
    sketch={via:'pre-plain', tag:row.tagName, attrs:[...row.attributes].map(a=>a.name), hasSelectable:!!row.querySelector('span.selectable-text'), hasCopyable:!!row.querySelector('.copyable-text')}; }
  else { const di=document.querySelector("#main div[data-id]"); if(di){ sketch={via:'data-id', tag:di.tagName, attrs:[...di.attributes].map(a=>a.name), spans:di.querySelectorAll('span').length}; } }
  return {opened:n('#main')>0, probe, sketch};
})()
