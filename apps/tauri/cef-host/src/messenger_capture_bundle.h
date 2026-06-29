// messenger_capture_bundle.h — Holo Messenger capture, the CSP-PROOF way.
//
// A spliced holo:// <script> is refused by strict-CSP messenger sites (web.whatsapp.com etc.) — the
// same limitation that moved Playground to host-inject. So this is a SELF-CONTAINED, dependency-free
// IIFE that app.cc ExecuteJavaScript()s into every real web page's MAIN WORLD (not CSP-gated). It
// self-gates: on a page no messenger adapter owns it returns immediately (inert). On a messenger
// client it observes rendered message rows and posts the RAW captured fields on the "holo-messenger"
// BroadcastChannel; the inbox tab (which holds the real holo-pluck / thread / epoch modules) mints the
// κ, seals, and ingests. Keeping the injected code free of κ/crypto logic keeps it trivially correct;
// the selector table mirrors holo-bridge-adapters.mjs (the one source of platform truth).
//
// No import, no fetch, no Hologram origin needed. One raw-string literal, well under the MSVC 16380-byte
// cap. Injected by app.cc OnContextCreated for non-holo http/file main frames.
#ifndef HOLO_MESSENGER_CAPTURE_BUNDLE_H
#define HOLO_MESSENGER_CAPTURE_BUNDLE_H
const char kHoloMessengerCaptureBundle[] =
R"HOLOMSGRCAP((()=>{try{
if(typeof BroadcastChannel==="undefined"||typeof document==="undefined")return;
var ADAPTERS=[
 {id:"whatsapp",hosts:["web.whatsapp.com"],row:"div.message-in, div.message-out, div[role='row']",
  text:"span.selectable-text, .copyable-text span",chat:"#main header span[dir='auto'], header span[dir='auto']",
  cap:{sel:"[data-pre-plain-text]",attr:"data-pre-plain-text",re:/^\[([^,\]]+),[^\]]*\]\s*(.*?):\s*$/,t:1,s:2}},
 {id:"telegram",hosts:["web.telegram.org"],row:".message, .Message, div[data-mid]",
  text:".text-content, .message-text, .translatable-message",sender:".peer-title, .sender-title, .message-title-name",
  time:".time, .message-time, .MessageMeta time",timeAttr:"title",chat:".chat-info .title, .ChatInfo .title, .top .info .title"},
 {id:"discord",hosts:["discord.com","discordapp.com"],row:"li[id^='chat-messages'], div[class*='message_']",
  text:"div[id^='message-content'], div[class*='messageContent']",sender:"span[id^='message-username'] span, span[class*='username']",
  time:"time",timeAttr:"datetime",chat:"section[aria-label] h1, h1[class*='title'], div[class*='title'] h3"},
 {id:"slack",hosts:["app.slack.com"],row:"div[data-qa='message_container'], div.c-message_kit__message",
  text:"div.c-message__body, div.p-rich_text_section, span.c-message__body",
  sender:"a.c-message__sender_link, span[data-qa='message_sender_name'], button.c-message__sender_button",
  time:"a.c-timestamp, span.c-timestamp",timeAttr:"aria-label",chat:"div.p-view_header__channel_title, span[data-qa='channel_name']"},
 {id:"x",hosts:["x.com","twitter.com","mobile.twitter.com"],row:"div[data-testid='messageEntry']",
  text:"div[data-testid='tweetText'], div[data-testid='messageEntry'] span",time:"time",timeAttr:"datetime",chat:"h2[role='heading'] span"},
 {id:"messenger",hosts:["www.messenger.com","messenger.com"],row:"div[role='row'], div[data-scope='messages_table']",
  text:"div[dir='auto'] span, div[data-content-type='text']",chat:"div[role='main'] h1 span, span[role='heading']"},
 {id:"instagram",hosts:["www.instagram.com","instagram.com"],row:"div[role='row'], div[data-scope='messages_table']",
  text:"div[dir='auto'] span, div[data-content-type='text']",chat:"div[role='main'] header span, span[role='heading']"},
 {id:"linkedin",hosts:["www.linkedin.com","linkedin.com"],row:"li.msg-s-event-listitem, div.msg-s-event-listitem",
  text:".msg-s-event-listitem__body, p.msg-s-event-listitem__body",sender:".msg-s-message-group__name, span.msg-s-message-group__profile-link",
  time:"time.msg-s-message-group__timestamp, time",timeAttr:"datetime",chat:"h2.msg-entity-lockup__entity-title, div.msg-thread__topbar h2"},
 {id:"gmessages",hosts:["messages.google.com"],row:"mws-message-wrapper, div[data-e2e-message-wrapper]",
  text:"mws-text-message-part .text-msg-content, div.text-msg-content",time:"mws-relative-timestamp, span.timestamp",timeAttr:"title",
  chat:"mws-conversation-title span, h2.conversation-title"}
];
var host=String(location.hostname||"").toLowerCase();
function resolve(){for(var i=0;i<ADAPTERS.length;i++){var hs=ADAPTERS[i].hosts;for(var j=0;j<hs.length;j++){if(host===hs[j]||host.endsWith("."+hs[j]))return ADAPTERS[i];}}return null;}
var A=resolve();if(!A)return;
try{window.__holoMessengerArmed=A.id;}catch(e){}
function first(root,multi){if(!root||!multi)return null;var p=String(multi).split(",");for(var i=0;i<p.length;i++){var s=p[i].trim();if(!s)continue;var f=root.querySelector(s);if(f)return f;}return null;}
function txt(n){return (n&&(n.innerText!=null?n.innerText:n.textContent)||"").trim();}
function at(n,name){return n&&n.getAttribute?n.getAttribute(name):null;}
function capture(row){
 var sender="",sentAt="";
 if(A.cap){var c=first(row,A.cap.sel);var pre=c&&at(c,A.cap.attr);var m=pre&&A.cap.re.exec(pre);if(m){sentAt=(m[A.cap.t]||"").trim();sender=(m[A.cap.s]||"").trim();}}
 var text=txt(first(row,A.text));
 if(!sender&&A.sender){var n=first(row,A.sender);sender=(A.senderAttr?(at(n,A.senderAttr)||""):txt(n)).trim();}
 if(!sentAt&&A.time){var n2=first(row,A.time);sentAt=(A.timeAttr?(at(n2,A.timeAttr)||""):txt(n2)).trim();}
 var chat="";if(A.chat){var cn=first(document,A.chat);chat=(A.chatAttr?(at(cn,A.chatAttr)||""):txt(cn)).trim();}
 return {text:text,sender:sender,sentAt:sentAt,chat:chat,source:location.hostname};
}
var bc=new BroadcastChannel("holo-messenger");
var seen=(typeof WeakSet!=="undefined")?new WeakSet():null;
function emit(row){if(seen){if(seen.has(row))return;seen.add(row);}var inp=capture(row);if(inp&&inp.text){var payload={holoMessengerCapture:true,platform:A.id,input:inp};
 try{bc.postMessage(payload);}catch(e){}
 /* cross-origin: BroadcastChannel can't reach the holo://os inbox, so relay through the host bridge (cefQuery is registered for every frame). The host forwards to the inbox; the inbox mints+verifies. */
 try{if(window.cefQuery){window.cefQuery({request:"holo:capture:"+encodeURIComponent(JSON.stringify(payload)),persistent:false,onSuccess:function(){},onFailure:function(){}});}}catch(e){}}}
function scan(){var rows=document.querySelectorAll(A.row);for(var i=0;i<rows.length;i++)emit(rows[i]);}
function start(){scan();try{var mo=new MutationObserver(scan);mo.observe(document.body,{childList:true,subtree:true});}catch(e){}}
if(document.body)start();else{var iv=setInterval(function(){if(document.body){clearInterval(iv);start();}},120);}
try{console.log("[holo-messenger] capture armed on "+A.id+" — messages stream to your inbox");}catch(e){}
}catch(e){}})();)HOLOMSGRCAP";
#endif
