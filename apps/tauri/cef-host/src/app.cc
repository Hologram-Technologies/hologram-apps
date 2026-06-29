// app.cc — κ scheme + real Chrome window + the origin-tiered Hologram bridge.
#include "app.h"

#include <cstdlib>
#include <fstream>
#include <string>
#include <unordered_map>

#include "include/cef_browser.h"
#include "include/cef_command_line.h"
#include "include/cef_frame.h"
#include "include/cef_request_context.h"  // pin DevTools dock side (right) + golden-ratio width
#include "include/cef_scheme.h"
#include "include/cef_values.h"
#include "include/base/cef_callback.h"          // base::BindOnce / OnceCallback (complete type for the deferred task)
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_closure_task.h"  // CefPostDelayedTask — defer non-critical boot work off the path

#include "closure_anchor.h"
#include "handler.h"
#include "hot_store.h"      // HotStore — live-anchor hot-reload of the sealed image (no reseal poisoning)
#include "mesh_supervisor.h"  // auto-spawn + supervise the always-on mesh node (planetary network, zero input)
#include "broker_server.h"  // self-contained loopback HTTP server for the step-up WebAuthn broker
#include "kappa_route.h"
#include "kappa_scheme.h"
#include "devtools_bundle.h"    // kHoloDevToolsBundle — host-injected, drift-proof DevTools dock (every app tab)
#include "playground_bundle.h"  // kHoloPlaygroundBundle — host-injected, CSP-proof Playground runtime
#include "youtube_bundle.h"     // kHoloYoutubeBundle — host-injected YouTube player swap (self-gates to youtube.com)
#include "messenger_capture_bundle.h"  // kHoloMessengerCaptureBundle — host-injected, CSP-proof messenger capture

namespace {
// window.HoloBridge — the per-tab seam to the browser-process Hologram service. Injected ONLY into
// holo:// frames (origin-tiered). Thin wrapper over window.cefQuery; the browser side re-checks the
// origin and refuses anything non-holo (defense in depth).
const char kHoloBridgeShim[] =
    "(function(){if(window.HoloBridge)return;"
    "function q(req){return new Promise(function(res,rej){window.cefQuery({request:req,persistent:false,"
    "onSuccess:function(r){try{res(JSON.parse(r));}catch(e){res(r);}},onFailure:function(c,m){rej(m);}});});}"
    "window.HoloBridge={call:function(cmd,arg){return q('holo:svc:'+cmd+(arg?(':'+arg):''));}};"
    "})();";

// The privileged Hologram service (P2). Injected ONLY into the OS home frame (holo://os/home — the shell,
// the one trusted context that loads the real OS modules). Defines window.__holoSvc(id, cmd, origin): it
// runs the REAL holo-resolve (THE one intent front door), preferring window.Q.intent / HoloResolve when
// the brain is wired and degrading honestly to the baseline classifier when it is not; it also exposes
// substrate κ. Results return through the relay via window.cefQuery('holo:svcreply:<id>:<json>'). The
// browser process holds no Hologram logic — intent and governance are decided here, in the shell.
const char kHoloServiceShim[] =
    "(function(){if(window.__holoSvc)return;"
    "var DIR='holo://os/usr/lib/holo/';var BASE=DIR+'holo-resolve.mjs';"
    "function reply(id,out){window.cefQuery({request:'holo:svcreply:'+id+':'+JSON.stringify(out),"
    "persistent:false,onSuccess:function(){},onFailure:function(){}});}"
    "async function sha256hex(s){var h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));"
    "return Array.from(new Uint8Array(h)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');}"
    "function hexOf(x){return String(x||'').replace(/^did:holo:sha256:/,'');}"
    "var RP=null;function resolver(){"
    "if(window.HoloResolve)return Promise.resolve(window.HoloResolve);"
    "if(!RP){RP=import(BASE).then(function(M){return M.makeResolver({intent:function(t){"
    "return (window.Q&&window.Q.intent)?window.Q.intent(t):{kind:'ask',target:t};},"
    "isNav:M.looksLikeNavigation});});}return RP;}"
    // govVerdict(url): the user's REAL sealed constitution judges a destination. A URL carrying PII
    // (scanPii) sets disclosesPii → red-line P5 (data minimisation) → block; clean → accept. Fail-closed
    // if the constitution can't self-verify (L5). Shared by the `gov` verb and the OnBeforeBrowse relay.
    "async function govVerdict(u){var C=await import(DIR+'holo-conscience.js');"
    "if(!(C.sealed&&C.sealed()))await C.verifyConstitution();"
    "var dec;try{dec=decodeURIComponent(u);}catch(e){dec=u;}"
    "var pii=C.scanPii(dec);var ev=C.evaluate({disclosesPii:pii.length>0},{posture:'strict'});"
    "return {outcome:ev.outcome,blocked:ev.blocked,caveats:ev.caveats,sealed:ev.sealed,"
    "pii:pii.map(function(p){return p.type;})};}"
    // composeSurface(intent): the witnessed planner composes a content-addressed surface of REAL apps.
    "async function composeSurface(arg){var SP=await import('holo://os/apps/spaces/holo-spaces-plan.mjs');"
    "var ds=[];try{ds=(await (await fetch('holo://os/apps/index.jsonld',{cache:'no-store'})).json())['dcat:dataset']||[];}catch(e){}"
    "var catalog=ds.map(function(a){return {root:hexOf(a['@id']),name:a['schema:name']||'app',"
    "desc:a['schema:description']||'',id:a['schema:identifier']||'',keywords:a['schema:keywords']||[],"
    "categories:a['holo:categories']||[]};}).filter(function(a){return a.root&&"
    "a.id!=='org.hologram.HoloSpaces'&&a.id!=='org.hologram.HoloOS';});"
    "var q=(window.Q&&(window.Q.generate||window.Q.ask))?window.Q:null;"
    "var spec=q?await SP.planWithQ(arg,catalog,q):SP.planSpace(arg,catalog);"
    "var canon=JSON.stringify({intent:arg,layout:spec.layout,mood:spec.mood,accent:spec.accent,"
    "members:spec.members.map(function(m){return m.root;})});var sk=await sha256hex(canon);"
    "var members=spec.members.map(function(m){var hx=hexOf(m.root);"
    "var c=catalog.find(function(x){return x.root===hx;})||{};"
    "return {kappa:m.root,name:c.name||'app',url:'holo://'+hx+'/'};});"
    "return {ok:true,intent:arg,surfaceKappa:'did:holo:sha256:'+sk,title:spec.name,"
    "layout:spec.layout,mood:spec.mood,accent:spec.accent,members:members,via:q?'Q':'planner',"
    "primary:(members[0]||{}).url||null};}"
    "window.__holoSvc=async function(id,cmd,origin){var out;try{"
    "var sp=cmd.indexOf(':');var verb=sp<0?cmd:cmd.slice(0,sp);var arg=sp<0?'':cmd.slice(sp+1);"
    "if(verb==='ping'){out={ok:true,service:'hologram',context:location.href,origin:origin};}"
    "else if(verb==='resolve'){var R=await resolver();var d=await R.resolve(arg,{source:'browser',"
    "context:{origin:origin}});out={ok:true,verb:'resolve',lane:d.lane,kind:d.kind,target:d.target,"
    "handled:d.handled,q:!!(window.Q&&window.Q.intent)};}"
    "else if(verb==='kappa'){var enc=new TextEncoder().encode(arg);"
    "var h=await crypto.subtle.digest('SHA-256',enc);"
    "var hex=Array.from(new Uint8Array(h)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');"
    "out={ok:true,verb:'kappa',kappa:'did:holo:sha256:'+hex};}"
    // step-up gate (P3): an app frame REQUESTS step-up; the HOST builds the action and computes the
    // action κ (challengeFor = sha256(canon)), asserts the operator host-side, and runs the REAL gate.
    // No TEE here ⇒ enforce fails closed for sensitive kinds (the gate denies), passes low-risk kinds.
    "else if(verb==='stepup'){var req;try{req=JSON.parse(arg);}catch(e){req={};}"
    "var SU=await import(DIR+'holo-stepup.mjs');var GATE=await import(DIR+'holo-stepup-gate.mjs');"
    "var op=(window.HoloIdentity&&window.HoloIdentity.operator&&window.HoloIdentity.operator.kappa)||null;"
    "var opSrc=op?'device':'host-synthetic';if(!op){op='did:holo:sha256:'+'00'.repeat(32);}"
    "var action={kind:req.kind||'wallet.send',payload:req.payload||null,appId:origin,operator:op,reason:req.reason||''};"
    "var challenge=await SU.challengeFor(action);"
    "var res=await GATE.enforce(action,{});"
    "out={ok:true,verb:'stepup',level:SU.levelOf(action.kind),"
    "gate:{ok:res.ok,suppressed:!!res.suppressed,reason:res.reason||null},"
    "challenge:challenge,operator:op,operatorSource:opSrc,"
    "note:'action κ computed HOST-side; app supplied only kind/payload — it cannot forge operator or binding'};}"
    // witnessed orchestration in-browser: classify→require→verify→trust-window→fail-closed→tamper-reject.
    "else if(verb==='stepup-selftest'){"
    "var SU=await import(DIR+'holo-stepup.mjs');var GATE=await import(DIR+'holo-stepup-gate.mjs');"
    "var su=await SU.selftest();var gate=await GATE.selftest();"
    "var allSU=Object.keys(su).every(function(k){return su[k];});"
    "var allG=Object.keys(gate).every(function(k){return gate[k];});"
    "out={ok:true,verb:'stepup-selftest',stepup:{all:allSU,checks:su},gate:{all:allG,checks:gate}};}"
    // white-box: the constitution's verdict over a URL (the same call OnBeforeBrowse enforces).
    "else if(verb==='gov'){var g=await govVerdict(arg);out={ok:true,verb:'gov',url:arg,"
    "outcome:g.outcome,blocked:g.blocked,caveats:g.caveats,sealed:g.sealed,pii:g.pii};}"
    // compose (P5): intent → Q composes a content-addressed surface of REAL apps (renderable κ-tabs).
    // The planner is the witnessed baseline; window.Q is the silent upgrade (planWithQ validates every
    // pick against the catalog — content-addressing is never Q's to bypass). The spec is hashed → a
    // re-derivable surface κ (L5). `compose` returns the plan; `compose-open` also STREAMS it in as tabs.
    "else if(verb==='compose'){out=await composeSurface(arg);out.verb='compose';}"
    "else if(verb==='compose-open'){var s=await composeSurface(arg);"
    "var opened=[];(s.members||[]).forEach(function(m){opened.push(m.url);"
    "window.cefQuery({request:'holo:open:'+m.url,persistent:false,onSuccess:function(){},onFailure:function(){}});});"
    "out={ok:true,verb:'compose-open',intent:arg,surfaceKappa:s.surfaceKappa,title:s.title,"
    "via:s.via,opened:opened,members:s.members};}"
    // compose-surface (materialize-on-arrival): build a self-verifying SHARE LINK — the surface spec
    // travels in the fragment; the pinned holo-surface.html viewer re-derives κ (L5) and tiles the
    // members. One first-class, shareable, isolated surface (vs N separate tabs in compose-open).
    "else if(verb==='compose-surface'){var s=await composeSurface(arg);"
    "var linkSpec={intent:s.intent,layout:s.layout,mood:s.mood,accent:s.accent,"
    "members:s.members.map(function(m){return {kappa:m.kappa,name:m.name};}),"
    "surfaceKappa:s.surfaceKappa,title:s.title};"
    "var b64=btoa(unescape(encodeURIComponent(JSON.stringify(linkSpec))))"
    ".replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');"
    "var url='holo://os/holo-surface.html#'+b64;"
    "window.cefQuery({request:'holo:open:'+url,persistent:false,onSuccess:function(){},onFailure:function(){}});"
    "out={ok:true,verb:'compose-surface',intent:arg,surfaceKappa:s.surfaceKappa,title:s.title,"
    "via:s.via,surfaceUrl:url,members:s.members};}"
    // WebAuthn PASSKEY PROVIDER (P4): a WEB page called navigator.credentials.get(); the host routed the
    // ceremony here with the REAL committed origin (3rd arg — the page cannot forge it). We sign with a
    // vault-resident passkey after the TEE step-up. The private key never leaves this trusted context.
    "else if(verb==='webauthn'){var req;try{req=JSON.parse(arg);}catch(e){req={};}"
    "var O,H;try{O=new URL(origin).origin;H=new URL(origin).hostname;}catch(e){O=origin;H=origin;}"
    "var rpId=req.rpId||H;var V=window.__holoPassVault;"
    "if(!V){out={ok:false,verb:'webauthn',error:'vault locked'};}"
    "else{var PK=await import(DIR+'holo-passkey.mjs');"
    // REGISTRATION: navigator.credentials.create → mint a per-rp passkey, store it in the vault (opening
    // the vault is itself the biometric/user-verification). Returns the attestation for the relying party.
    "if(req.type==='create'){"
    "var cc=await PK.createCredential({rpId:rpId,rpName:req.rpName||rpId,userId:req.userId,userName:req.userName||'',userDisplayName:req.userDisplayName||'',challenge:req.challenge,origin:O,signCount:0});"
    "await V.put({origin:rpId,kind:'passkey',username:req.userName||null,secret:JSON.stringify(cc.store)});"
    "out={ok:true,verb:'webauthn',credential:cc.credential};"
    "}else{"
    "var r=await PK.getAssertion({rpId:rpId,challenge:req.challenge,origin:O,allowCredentials:req.allowCredentials||[]},{"
    "lookup:function(rp,ids){return Promise.resolve(V.get(rp)).then(function(e){if(!e||e.kind!=='passkey')return null;try{return JSON.parse(e.secret);}catch(_){return null;}});},"
    "stepup:function(a){return (typeof window.__holoStepUp==='function')?window.__holoStepUp(a):import(DIR+'holo-stepup.mjs').then(function(SU){return SU.requireStepUp(a,{});});},"
    "persist:function(rec){return Promise.resolve(V.put({origin:rec.rpId,kind:'passkey',username:rec.userName||null,secret:JSON.stringify(rec)}));}"
    "});out={ok:true,verb:'webauthn',credential:r.credential,signCount:r.signCount};}}}"
    // [holo-cred] UNIFIED web2 credential ops over the unlocked vault (origin = host-supplied, 3rd arg).
    // fill: return the saved login for THIS exact verified origin (seamless — the login biometric opened
    // the vault). save: a one-tap PROPOSAL to remember a submitted login. totp: the live 2FA code.
    "else if(verb==='cred'){var req;try{req=JSON.parse(arg);}catch(e){req={};}"
    "var O;try{O=new URL(origin).origin;}catch(e){O=origin;}"
    "var V=window.__holoPassVault;"
    "if(!V&&req.op!=='web3'){out={ok:false,verb:'cred',error:'vault unavailable'};}"
    "else if(req.op==='fill'){var es=await V.list();var hit=es.find(function(x){return x.origin===O&&x.kind==='password';});"
    "if(hit){var f=await V.get(hit.id);out={ok:true,verb:'cred',op:'fill',u:(f&&f.username)||'',p:f&&f.secret};}else{out={ok:true,verb:'cred',op:'fill',u:null,p:null};}}"
    "else if(req.op==='has'){var es=await V.list();var hit=es.find(function(x){return x.origin===O&&x.kind==='password';});out={ok:true,verb:'cred',op:'has',exists:!!hit,username:hit?(hit.username||''):null};}"
    "else if(req.op==='save'){if(req.p==null||req.p===''){out={ok:false,verb:'cred',error:'nothing to save'};}else{await V.put({origin:O,kind:'password',username:req.u||null,secret:req.p});out={ok:true,verb:'cred',op:'save',saved:true};}}"
    "else if(req.op==='totp'){var e2=await V.list();var th=e2.find(function(x){return x.origin===O&&x.kind==='totp';});"
    "if(th){var tf=await V.get(th.id);var TT=await import(DIR+'holo-totp.mjs');var rc=await TT.codeForEntry(tf);out={ok:true,verb:'cred',op:'totp',code:rc?rc.code:null};}else{out={ok:true,verb:'cred',op:'totp',code:null};}}"
    // [holo-cred web3] EIP-1193 over the relay: accounts/chainId are PUBLIC (no biometric); sign/send
    // are VALUE-level → always step-up gated. The dApp never sees a key; the wallet signs in the shell.
    "else if(req.op==='web3'){var W=window.__holoWallet;var m=req.method;"
    "if(m==='eth_requestAccounts'||m==='eth_accounts'){out={ok:true,verb:'cred',op:'web3',result:(W&&W.accounts)||[]};}"
    "else if(m==='eth_chainId'){out={ok:true,verb:'cred',op:'web3',result:(W&&W.chainId)||'0x1'};}"
    "else if(m==='net_version'){out={ok:true,verb:'cred',op:'web3',result:'1'};}"
    // SIGN methods now ride the ONE universal verb (window.HoloAuth.authorize SIGN/ethereum): same gate, same
    // key, PLUS an L5-verifiable authorization κ. The old __holoStepUp+W.sign duplicate path is retired.
    "else if(m==='personal_sign'||m==='eth_sign'||m==='eth_signTypedData_v4'){"
    "var A=window.HoloAuth;if(!A){out={ok:false,verb:'cred',error:'auth seam unavailable'};}else{"
    "var pl=(m==='personal_sign')?(req.params&&req.params[0]):(req.params&&req.params[1]);"   // personal_sign:[msg,addr]; eth_sign/typed:[addr,msg]
    "var ar=await A.authorize({subject:A.operatorKappa,context:O,mode:'SIGN',spec:{keyDomain:'ethereum',payload:pl}});"
    "out={ok:!!(ar&&ar.result&&ar.result.signature),verb:'cred',op:'web3',result:ar&&ar.result&&ar.result.signature,authorization:ar&&ar.authorization};}}"
    // eth_sendTransaction is a VALUE transfer (a wallet op, not an auth-signature): gated by the ONE gate
    // (__holoStepUp now delegates to holoGate) then the WDK send. Authentication=authorize; value=wallet.
    "else if(m==='eth_sendTransaction'){if(!W){out={ok:false,verb:'cred',error:'wallet locked'};}else{"
    "var tok=(typeof window.__holoStepUp==='function')?await window.__holoStepUp({kind:'wallet.send',appId:O,payload:{method:m,params:req.params}}):null;"
    "if(!tok){out={ok:false,verb:'cred',error:'step-up denied'};}else{"
    "var rr=await W.send((req.params&&req.params[0])||{});out={ok:true,verb:'cred',op:'web3',result:rr};}}}"
    "else{out={ok:false,verb:'cred',error:'unsupported web3 method: '+m};}}"
    "else{out={ok:false,verb:'cred',error:'unknown cred op: '+req.op};}}"
    // [holo-auth] THE universal authorization verb — every app and web page authenticates through the ONE
    // seam (window.HoloAuth.authorize: SIGN|RELEASE|PROVE + SIWE/OIDC). The app supplies ONLY mode/spec; the
    // HOST supplies the context (3rd arg origin — unforgeable) and the device operator κ is taken from the
    // session (never the app). One device-TEE biometric; the returned authorization is L5-verifiable + PQ.
    "else if(verb==='auth'){var req;try{req=JSON.parse(arg);}catch(e){req={};}"
    "var O;try{O=new URL(origin).origin;}catch(e){O=origin;}"
    "var A=window.HoloAuth;"
    "if(!A){out={ok:false,verb:'auth',error:'auth seam unavailable (guest or shell not ready)'};}"
    "else if(req.kind==='oidc'){var r=await A.signIn({audience:O,nonce:req.nonce||null,claims:req.claims||{},ttlSec:req.ttlSec||300});"
    "out={ok:!!(r&&r.idToken),verb:'auth',kind:'oidc',idToken:r&&r.idToken,jwks:r&&r.jwks,authorization:r&&r.authorization};}"
    "else if(req.kind==='siwe'){var r=await A.siwe({origin:O,siweMessage:req.siweMessage});"
    "out={ok:!!(r&&r.result),verb:'auth',kind:'siwe',signature:r&&r.result&&r.result.signature,authorization:r&&r.authorization};}"
    "else{var r=await A.authorize({subject:A.operatorKappa,context:O,mode:req.mode,spec:req.spec||{}});"
    "out={ok:!!(r&&r.authorization),verb:'auth',mode:req.mode,result:r&&r.result,authorization:r&&r.authorization,level:r&&r.level};}}"
    "else{out={ok:false,error:'unknown verb: '+verb};}"
    "}catch(e){out={ok:false,error:String((e&&e.message)||e)};}reply(id,out);};"
    // OnBeforeBrowse relay target: judge a held web navigation, reply allow|block (fail-closed to block).
    "window.__holoGov=async function(gid,url){var v='block';"
    "try{var g=await govVerdict(url);v=(g.outcome==='block')?'block':'allow';}catch(e){v='block';}"
    "window.cefQuery({request:'holo:govverdict:'+gid+':'+v,persistent:false,"
    "onSuccess:function(){},onFailure:function(){}});};"
    // OnBeforeBrowse relay target for the native omnibox (Strategy A): resolve a raw typed query through the
    // SAME resolver the shell uses (holo-omni-resolve over the live catalog) and reply with the canonical
    // destination. A deterministic shape → its URL. A live shape (web3 ENS/0x, owned holo-name) → the shell
    // opens it here via HoloOpen and we reply EMPTY so the host no-ops. Unknown → Holo Find. Never invents.
    "window.__holoOmniResolve=async function(rid,q){var dest='';try{"
    "var R=window.HoloResolve;"
    "if(!R){try{var M=await import(DIR+'holo-omni-resolve.mjs');R={resolve:function(x){return M.resolveDestination(x,{catalog:(window.__holoCatalog||[])});}};}catch(e){R=null;}}"
    "var r=R?R.resolve(q):null;"
    "if(r&&r.url&&!r.defer){dest=r.url;}"
    "else if(r&&r.defer){try{if(window.HoloOpen)window.HoloOpen(q);}catch(e){}dest='';}"
    "else{dest='holo://os/find.html?q='+encodeURIComponent(q);}"
    "}catch(e){dest='holo://os/find.html?q='+encodeURIComponent(q);}"
    "window.cefQuery({request:'holo:omniresolved:'+rid+':'+dest,persistent:false,onSuccess:function(){},onFailure:function(){}});};"
    // In-place extension install (the seamless, Chrome-like path). The store-page "Add to Hologram" button
    // relays here (origin holo://os — the trusted shell). Fetch the CRX host-side (crxfetch, no CORS),
    // verify κ + publisher signature (Law L5), classify, persist to the κ-extensions store, and reply with
    // the result so the store page shows an in-place toast — no tab switch.
    "window.__holoInstallExt=async function(qid,id){var out;try{"
    "var b64=await new Promise(function(res,rej){window.cefQuery({request:'holo:crxfetch:'+id,persistent:false,"
    "onSuccess:res,onFailure:function(c,m){rej(new Error(m||'fetch failed'));}});});"
    "var bin=atob(b64),arr=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);"
    "var M=await import(DIR+'holo-ext-install.mjs');var CRX=await import(DIR+'holo-crx.js');"
    "var v=await M.verifyStrict(arr);if(!v.ok)throw new Error('verification failed (Law L5)');"
    "var a=CRX.analyzeManifest(await CRX.readManifest(arr));"
    "var K='holo.ext.installed',list={};try{list=JSON.parse(localStorage.getItem(K))||{}}catch(e){}"
    "list[v.extensionId]={id:v.extensionId,kappa:v.kappa,name:a.name,version:a.version,verdict:a.verdict,needsNative:a.verdict==='needs-native',at:Date.now()};"
    "try{localStorage.setItem(K,JSON.stringify(list));}catch(e){}"
    "out={ok:true,name:a.name,version:a.version,kappa:v.kappa,verdict:a.verdict,needsNative:a.verdict==='needs-native'};"
    "}catch(e){out={ok:false,error:String((e&&e.message)||e)};}"
    "window.cefQuery({request:'holo:svcreply:'+qid+':'+JSON.stringify(out),persistent:false,onSuccess:function(){},onFailure:function(){}});};"
    "})();";

// WebAuthn passkey provider — web-frame shim (P4). Overrides navigator.credentials.get so any site's
// passkey ceremony is answered by the operator's Hologram vault, brokered through window.cefQuery to the
// trusted holo://os shell. Carries NO secret: the private key and signer stay in the shell process; this
// shim only forwards the challenge and rebuilds a PublicKeyCredential. If the host declines (no passkey /
// vault locked) it transparently defers to the platform authenticator. The host supplies the true origin.
const char kHoloWebAuthn[] =
    "(function(){try{if(window.__holoPk)return;"
    "function q(req){return new Promise(function(res,rej){window.cefQuery({request:req,persistent:false,"
    "onSuccess:function(r){try{res(JSON.parse(r));}catch(e){rej(e);}},onFailure:function(c,m){rej(new Error(m||'holo'));}});});}"
    "function b2u(buf){var u=new Uint8Array(buf),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}"
    "function u2b(s){s=String(s).replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;}"
    // navigator.credentials may be absent at OnContextCreated (secure-context promotion lags commit), so
    // install on a capped retry until it appears, then override get() permanently.
    "function install(){try{if(window.__holoPk)return true;if(!navigator.credentials||!navigator.credentials.get)return false;"
    "var orig=navigator.credentials.get.bind(navigator.credentials);"
    "navigator.credentials.get=function(opts){try{"
    "if(!opts||!opts.publicKey)return orig(opts);"
    "var pk=opts.publicKey;var rpId=pk.rpId||location.hostname;var challenge=b2u(pk.challenge);"
    "var allow=(pk.allowCredentials||[]).map(function(c){return b2u(c.id);});"
    "return q('holo:webauthn:'+JSON.stringify({type:'get',rpId:rpId,challenge:challenge,allowCredentials:allow})).then(function(res){"
    "if(!res||!res.ok||!res.credential){window.__holoPkErr='not-ok:'+JSON.stringify(res).slice(0,160);return orig(opts);}"
    "var c=res.credential;"
    "return {id:c.id,rawId:u2b(c.rawId),type:'public-key',authenticatorAttachment:'platform',"
    "response:{authenticatorData:u2b(c.response.authenticatorData),clientDataJSON:u2b(c.response.clientDataJSON),signature:u2b(c.response.signature),userHandle:c.response.userHandle?u2b(c.response.userHandle):null},"
    "getClientExtensionResults:function(){return {};}};"
    "}).catch(function(e){window.__holoPkErr='then-catch:'+String(e);return orig(opts);});"
    "}catch(e){window.__holoPkErr='sync-catch:'+String(e);return orig(opts);}};if(navigator.credentials.create){var origC=navigator.credentials.create.bind(navigator.credentials);navigator.credentials.create=function(opts){try{if(!opts||!opts.publicKey||!opts.publicKey.user)return origC(opts);var pk=opts.publicKey;var rpId=(pk.rp&&pk.rp.id)||location.hostname;var rpName=(pk.rp&&pk.rp.name)||rpId;var challenge=b2u(pk.challenge);var userId=b2u(pk.user.id);var userName=pk.user.name||'';var userDisplayName=pk.user.displayName||'';return q('holo:webauthn:'+JSON.stringify({type:'create',rpId:rpId,rpName:rpName,challenge:challenge,userId:userId,userName:userName,userDisplayName:userDisplayName})).then(function(res){if(!res||!res.ok||!res.credential){window.__holoPkErr='create-not-ok:'+JSON.stringify(res).slice(0,160);return origC(opts);}var c=res.credential;var ad=u2b(c.response.attestationObject);return {id:c.id,rawId:u2b(c.rawId),type:'public-key',authenticatorAttachment:'platform',response:{attestationObject:ad,clientDataJSON:u2b(c.response.clientDataJSON),getAuthenticatorData:function(){return ad;},getPublicKey:function(){return null;},getPublicKeyAlgorithm:function(){return -7;},getTransports:function(){return ['internal'];}},getClientExtensionResults:function(){return {};}};}).catch(function(e){window.__holoPkErr='create-catch:'+String(e);return origC(opts);});}catch(e){return origC(opts);}};}window.__holoPk=1;return true;}catch(e){return false;}}"
    "if(!install()){var n=0,iv=setInterval(function(){if(install()||++n>600)clearInterval(iv);},16);"
    "if(document.addEventListener)document.addEventListener('DOMContentLoaded',install);}"
    "}catch(e){}})();";

// kHoloCred — the web2 half of the unified credential relay, injected into web frames. Finds the login
// form, asks the host (holo:cred op:fill) for a saved login for THIS verified origin and fills it; on
// submit it offers the typed login to the vault (op:save); a one-time-code field is filled from the
// vault's TOTP (op:totp). Carries NO secret and never sends an origin (the host supplies the real one).
const char kHoloCred[] =
    "(function(){try{if(window.__holoCred)return;"
    "function q(req){return new Promise(function(res,rej){window.cefQuery({request:req,persistent:false,onSuccess:function(r){try{res(JSON.parse(r));}catch(e){rej(e);}},onFailure:function(c,m){rej(new Error(m||'holo'));}});});}"
    "function fields(){var ins=[].slice.call(document.querySelectorAll('input')).filter(function(e){return e.type!=='hidden'&&e.type!=='submit'&&e.type!=='button';});"
    "var pw=ins.filter(function(e){return (e.type||'').toLowerCase()==='password';});"
    "var uf=null;if(pw.length){var pi=ins.indexOf(pw[0]);for(var i=pi-1;i>=0;i--){var t=(ins[i].type||'text').toLowerCase();if(t==='email'||t==='text'){uf=ins[i];break;}}}"
    "var otp=ins.filter(function(e){var a=((e.autocomplete||'')+' '+(e.name||'')+' '+(e.id||'')).toLowerCase();return a.indexOf('one-time-code')>=0||a.indexOf('otp')>=0||a.indexOf('totp')>=0||a.indexOf('2fa')>=0;})[0]||null;"
    "return {user:uf,pass:pw[0]||null,otp:otp,signup:pw.length>=2};}"
    "function setv(el,v){if(!el)return;var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');if(d&&d.set){d.set.call(el,v);}else{el.value=v;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
    "function doFill(){q('holo:cred:'+JSON.stringify({op:'fill'})).then(function(r){if(r&&r.ok&&r.p){var f=fields();if(f.user&&r.u)setv(f.user,r.u);if(f.pass)setv(f.pass,r.p);window.__holoCredFilled=true;}}).catch(function(){});}"
    "function chip(user){if(document.getElementById('holo-signin-chip')||!document.body)return;var f=fields();if(!f.pass)return;var b=document.createElement('button');b.id='holo-signin-chip';b.type='button';b.setAttribute('aria-label','Sign in with Hologram');b.textContent='\\uD83D\\uDC46 Sign in'+(user?(' as '+user):'')+' \\u2014 Hologram';"
    "b.style.cssText='position:fixed;z-index:2147483000;right:16px;bottom:16px;padding:10px 14px;border:0;border-radius:10px;background:#6fa8ff;color:#06121f;font:600 13px system-ui;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3)';"
    "b.onclick=function(){b.disabled=true;b.textContent='\\u2026';doFill();setTimeout(function(){try{b.remove();}catch(e){}},500);};document.body.appendChild(b);}"
    "function detect(){var f=fields();if(f.pass&&!f.signup&&!window.__holoCredHas){q('holo:cred:'+JSON.stringify({op:'has'})).then(function(r){if(r&&r.ok&&r.exists){window.__holoCredHas=true;chip(r.username);}}).catch(function(){});}"
    "if(f.otp){q('holo:cred:'+JSON.stringify({op:'totp'})).then(function(r){if(r&&r.ok&&r.code){setv(f.otp,r.code);}}).catch(function(){});}}"
    "function saveBanner(u,p){if(document.getElementById('holo-save-banner')||!document.body)return;var d=document.createElement('div');d.id='holo-save-banner';"
    "d.style.cssText='position:fixed;z-index:2147483000;left:50%;top:18px;transform:translateX(-50%);background:#0b0d10;color:#e8e8f0;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px 14px;font:13px system-ui;box-shadow:0 8px 28px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center';"
    "var sp=document.createElement('span');sp.textContent='Remember this login with Hologram?';var sv=document.createElement('button');sv.id='holo-save-yes';sv.textContent='Save';"
    "sv.style.cssText='all:unset;cursor:pointer;background:#6fa8ff;color:#06121f;font-weight:600;padding:6px 12px;border-radius:8px';var no=document.createElement('button');no.textContent='Not now';no.style.cssText='all:unset;cursor:pointer;color:#9aa3b8;padding:6px 8px';"
    "sv.onclick=function(){q('holo:cred:'+JSON.stringify({op:'save',u:u,p:p})).catch(function(){});try{d.remove();}catch(e){}};no.onclick=function(){try{d.remove();}catch(e){}};"
    "d.appendChild(sp);d.appendChild(sv);d.appendChild(no);document.body.appendChild(d);setTimeout(function(){try{d.remove();}catch(e){}},12000);}"
    "function hookSave(){document.addEventListener('submit',function(){try{var f=fields();if(f.pass&&f.pass.value){var u=f.user?f.user.value:'',p=f.pass.value;"
    "q('holo:cred:'+JSON.stringify({op:'has'})).then(function(r){if(!(r&&r.exists))saveBanner(u,p);}).catch(function(){saveBanner(u,p);});}}catch(e){}},true);}"
    "function installEth(){if(window.ethereum&&window.ethereum.isHologram)return;var P={isHologram:true,isMetaMask:false,_cbs:{},chainId:'0x1',selectedAddress:null,"
    "request:function(a){a=a||{};return q('holo:cred:'+JSON.stringify({op:'web3',method:a.method,params:a.params||[]})).then(function(r){if(!r||!r.ok)throw new Error((r&&r.error)||'rejected');if((a.method==='eth_requestAccounts'||a.method==='eth_accounts')&&r.result&&r.result[0])P.selectedAddress=r.result[0];return r.result;});},"
    "on:function(e,cb){(P._cbs[e]=P._cbs[e]||[]).push(cb);return P;},removeListener:function(e,cb){if(P._cbs[e])P._cbs[e]=P._cbs[e].filter(function(f){return f!==cb;});return P;},"
    "enable:function(){return this.request({method:'eth_requestAccounts'});}};"
    "try{Object.defineProperty(window,'ethereum',{value:P,writable:false,configurable:true});}catch(e){try{window.ethereum=P;}catch(e2){}}"
    "try{window.dispatchEvent(new Event('ethereum#initialized'));}catch(e){}"
    "var info={uuid:'6f9a3b2c-1d4e-4a8b-9c0d-1e2f3a4b5c6d',name:'Hologram',icon:'data:image/svg+xml,%3Csvg%2F%3E',rdns:'org.hologram.wallet'};"
    "function ann(){try{window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:Object.freeze({info:info,provider:P})}));}catch(e){}}"
    "window.addEventListener('eip6963:requestProvider',ann);ann();}"
    // window.HoloID — the public web API for the UNIVERSAL authenticator. A site calls HoloID.signIn() to get
    // a standards OIDC ID Token ('Sign in with Hologram'); HoloID.authorize({mode,spec}) for SIGN/RELEASE/PROVE;
    // HoloID.connect() for the wallet. All route through holo:auth → the ONE biometric in the trusted shell.
    "function installID(){if(window.HoloID)return;window.HoloID={"
    "signIn:function(o){o=o||{};return q('holo:auth:'+JSON.stringify({kind:'oidc',nonce:o.nonce||null,claims:o.claims||{},ttlSec:o.ttlSec||300})).then(function(r){if(!r||!r.ok)throw new Error((r&&r.error)||'denied');return {idToken:r.idToken,jwks:r.jwks,authorization:r.authorization};});},"
    "siwe:function(o){o=o||{};return q('holo:auth:'+JSON.stringify({kind:'siwe',siweMessage:o.siweMessage})).then(function(r){if(!r||!r.ok)throw new Error((r&&r.error)||'denied');return r;});},"
    "authorize:function(req){req=req||{};return q('holo:auth:'+JSON.stringify({mode:req.mode,spec:req.spec||{}})).then(function(r){if(!r||!r.ok)throw new Error((r&&r.error)||'denied');return r;});},"
    "connect:function(){return (window.ethereum?window.ethereum.request({method:'eth_requestAccounts'}):Promise.reject(new Error('no wallet')));}"
    "};}"
    "function start(){if(window.__holoCred)return;window.__holoCred=1;installEth();installID();hookSave();detect();}"
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',start);}else{start();}"
    "var n=0,iv=setInterval(function(){if(window.__holoCredHas||window.__holoCredFilled||++n>40){clearInterval(iv);return;}detect();},250);"
    "}catch(e){}})();";

// Cosmetic ad-slot collapse (the "magical finish"). Network blocking already stops the ads themselves;
// this hides the leftover empty ad CONTAINERS so the page re-flows as if ads never existed (positive-space
// rendering, not a page full of holes). Injected into web frames only. Selectors are curated to whole-token
// ad markers (advertisement / div-gpt-ad / adsbygoogle / data-ad-slot) to avoid hiding first-party content.
const char kHoloNoAdsCss[] =
    "(function(){if(window.__holoNoAds)return;window.__holoNoAds=1;"
    // IMPORTANT: hide only REAL, loaded ad IFRAMES — never generic ad-CLASS divs. Anti-adblock walls
    // (Admiral etc.) plant a bait <div class=\"ad ads advertisement adsbygoogle\"> and check if it got
    // hidden; hiding those is the #1 cosmetic detection trigger. A bait div is never an ad iframe, so this
    // selector set collapses actual ads without tripping bait detection. Empty ad slots simply stay empty
    // (the surrogates ensure no ad loads), which looks like a normal unfilled slot — nothing to detect.
    "var c='iframe[src*=\"doubleclick.net\"],iframe[src*=\"googlesyndication\"],"
    "iframe[src*=\"amazon-adsystem\"],iframe[src*=\"adnxs.com\"],iframe[src*=\"2mdn.net\"],"
    "iframe[src*=\"adsafeprotected\"],iframe[src*=\"google_ads\"],iframe[id^=\"google_ads_iframe\"],"
    "iframe[id*=\"-ad-iframe\"],iframe[aria-label=\"Advertisement\" i],iframe[title=\"Advertisement\" i]"
    "{display:none!important}';"
    "function add(){if(document.getElementById('holo-no-ads'))return true;"
    "var p=document.head||document.documentElement;if(!p)return false;"
    "var s=document.createElement('style');s.id='holo-no-ads';s.textContent=c;p.appendChild(s);return true;}"
    // At context-creation the DOM root can be null; keep trying (capped) until head/documentElement exists.
    "if(!add()){var n=0,iv=setInterval(function(){if(add()||++n>600)clearInterval(iv);},16);"
    "document.addEventListener('DOMContentLoaded',add);}"
    "})();";

// Anti-anti-adblock DEFUSER. Surrogates make blocking undetectable upstream; this is the belt-and-braces
// last resort for any wall that still renders: assert the "ads are allowed" flags pages probe, and — via a
// MutationObserver + a short interval — remove any large fixed/absolute/sticky high-z overlay whose text
// matches anti-adblock wording, and restore page scroll (walls lock <body> overflow). Web frames only.
// Tightly scoped (overlay position + size + anti-adblock-specific wording) to avoid touching real modals.
const char kHoloDefuserJs[] =
    "(function(){if(window.__holoDefuse)return;window.__holoDefuse=1;"
    "try{window.canRunAds=true;window.canShowAds=true;window.isAdBlockActive=false;window._cana=true;}catch(e){}"
    // Define inert ad-API stubs at document-start so presence-checks (window.googletag.defineSlot, ga,
    // gtag) pass even though no ad loads — the page's own gpt bootstrap keeps our object. This is the
    // reliable twin of the served surrogate: globals guaranteed here, ad requests succeed via the surrogate.
    "try{var gt=window.googletag=window.googletag||{};if(!gt.defineSlot){var q=gt.cmd||[];"
    "var n=function(){},nt=function(){return this;};"
    "var slot={addService:nt,setTargeting:nt,setCollapseEmptyDiv:nt,addEventListener:nt,removeEventListener:nt,"
    "setForceSafeFrame:nt,defineSizeMapping:nt,setSafeFrameConfig:nt,setClickUrl:nt,get:function(){return null;},"
    "getSlotElementId:function(){return'';},getAdUnitPath:function(){return'';},getTargeting:function(){return[];},"
    "getTargetingKeys:function(){return[];}};"
    "var pa={enableSingleRequest:n,enableServices:n,refresh:n,clear:n,setTargeting:nt,clearTargeting:nt,"
    "collapseEmptyDivs:n,addEventListener:nt,removeEventListener:nt,disableInitialLoad:n,enableLazyLoad:n,"
    "setRequestNonPersonalizedAds:n,setPrivacySettings:nt,setPublisherProvidedId:nt,setCentering:n,"
    "isInitialLoadDisabled:function(){return true;},getSlots:function(){return[];},updateCorrelator:n,get:function(){return null;}};"
    "gt.apiReady=true;gt.pubadsReady=true;gt.cmd=[];gt.cmd.push=function(f){try{f();}catch(e){}return 1;};"
    "gt.pubads=function(){return pa;};gt.enableServices=n;gt.display=n;gt.destroySlots=n;"
    "gt.defineSlot=function(){return slot;};gt.defineOutOfPageSlot=function(){return slot;};"
    "gt.sizeMapping=function(){return{addSize:nt,build:function(){return[];}};};gt.setAdIframeTitle=n;"
    "for(var i=0;i<q.length;i++){try{(typeof q[i]==='function')&&q[i]();}catch(e){}}}}catch(e){}"
    "try{window.ga=window.ga||function(){(window.ga.q=window.ga.q||[]).push(arguments);};window.ga.l=+new Date();"
    "window.gtag=window.gtag||function(){};window.dataLayer=window.dataLayer||[];}catch(e){}"
    "window.__holoWallsRemoved=0;"
    "var RE=/disabl\\w*\\s+(your\\s+)?ad.?block|ad.?block(er)?\\s+(detect|enabl)|powered by admiral|"
    "whitelist\\s+(this|our|us)|support us by disabling|turn off your ad.?block|using an ad.?block|"
    "please disable your ad|ad.?blocker (is )?(detected|on)/i;"
    "var ADH=/admiral|aadetect|getadmiral|adblockdetect|adsafeprotected/i;"
    "function locked(){try{return getComputedStyle(document.body).overflow==='hidden'||"
    "getComputedStyle(document.documentElement).overflow==='hidden';}catch(e){return false;}}"
    "function unlock(){try{var e=[document.documentElement,document.body];for(var i=0;i<e.length;i++){"
    "if(e[i]&&e[i].style){e[i].style.setProperty('overflow','visible','important');"
    "e[i].style.setProperty('overflow-y','auto','important');e[i].style.removeProperty('position');"
    "e[i].classList&&['modal-open','no-scroll','noscroll','overflow-hidden','adblock','admiral-engaged']"
    ".forEach(function(c){e[i].classList.remove(c);});}}}catch(e){}}"
    "function rm(e){try{e.remove();window.__holoWallsRemoved++;unlock();}catch(_){}}"
    "function overlay(e){try{var s=getComputedStyle(e);if(s.position!=='fixed'&&s.position!=='absolute'&&"
    "s.position!=='sticky')return false;if((parseInt(s.zIndex,10)||0)<50)return false;"
    "var r=e.getBoundingClientRect();return r.width>=240&&r.height>=110;}catch(_){return false;}}"
    "function consider(e){if(!e||e.nodeType!==1||e.__hc)return;"
    // cross-origin IFRAME wall: a big overlay iframe from a detector host, or any big overlay iframe while
    // the page scroll is locked (the classic anti-adblock pattern) — remove it.
    "if(e.tagName==='IFRAME'){if(overlay(e)&&(ADH.test(e.src||'')||locked())){e.__hc=1;rm(e);return;}return;}"
    // same-origin overlay: text matches anti-adblock wording → climb to the overlay ancestor and remove.
    "var t=e.innerText||e.textContent||'';if(t&&t.length<1400&&RE.test(t)){var top=e;"
    "for(var k=0;k<9&&top.parentElement&&top.parentElement!==document.body;k++){if(overlay(top))break;"
    "top=top.parentElement;}rm(top);}}"
    "function sweep(nodes){for(var i=0;i<nodes.length;i++){var n=nodes[i];if(n.nodeType!==1)continue;"
    "consider(n);if(n.querySelectorAll){var sub=n.querySelectorAll('div,section,aside,iframe');"
    "for(var j=0;j<sub.length&&j<120;j++)consider(sub[j]);}}}"
    "function full(){unlock();try{sweep(document.querySelectorAll('div,section,aside,iframe'));}catch(_){}}"
    // cheap observer: only inspect ADDED nodes (+ their immediate subtree), never re-scan the whole DOM.
    "var mo;function start(){full();try{mo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++)"
    "sweep(ms[i].addedNodes);unlock();});mo.observe(document.documentElement,{childList:true,subtree:true});}catch(_){}}"
    "if(document.documentElement)start();else document.addEventListener('DOMContentLoaded',start);"
    // light periodic safety net (scroll-unlock + a full sweep) for late/animated walls; runs ~30s.
    "var n=0,iv=setInterval(function(){full();if(++n>60)clearInterval(iv);},500);"
    // ── COLLAPSE EMPTY AD SLOTS (the seamless finish). The surrogates leave ad slots empty but they still
    // reserve space (big blank boxes). Collapse them — but NEVER hide a detection bait. SAFE signals first
    // (gpt slot id / data-google-query-id / an 'Advertisement' ::before label — real slots have these, bait
    // does not) run early; the broader generic-class pass runs only AFTER the detection window (2.6s+). Only
    // EMPTY slots collapse (a slot with a real visible ad iframe or media/text is left alone). Cheap: a few
    // timed passes with bounded queries, not a per-frame scan. ──
    // gpt/adsense slots are ALWAYS ads → collapse unconditionally; generic ad-class only after detection window.
    "var SAFESEL='[id^=\"div-gpt-ad\"],[id^=\"google_ads_iframe\"],[data-google-query-id],[data-ad-unit-path],[data-ad-slot]';"
    "var GENSEL='ins.adsbygoogle,[class*=\"ad-unit\"],[class*=\"ad-slot\"],[class*=\"ad-container\"],[class*=\"ad-wrapper\"],"
    "[class*=\"ad-placeholder\"],[class*=\"advert\"],[id*=\"-ad-\"],[id^=\"ad-\"],[id*=\"banner-ad\"],[class*=\"-ad-\"]';"
    "function lbl(e){try{return (getComputedStyle(e,'::before').content||'')+(getComputedStyle(e,'::after').content||'');}catch(_){return '';}}"
    // an 'Advertisement'/'Sponsored' label (often a ::before on the slot OR a child) = a real ad slot (bait has none).
    "function labeled(e){if(/advertis|sponsor/i.test(lbl(e)))return true;var c=e.children;"
    "for(var i=0;i<c.length&&i<5;i++)if(/advertis|sponsor/i.test(lbl(c[i])))return true;return false;}"
    "function substantial(e){try{if(e.querySelector('video,canvas'))return true;"
    "var im=e.querySelectorAll('img');for(var i=0;i<im.length;i++){var r=im[i].getBoundingClientRect();if(r.width>60&&r.height>40)return true;}"
    "return (e.innerText||'').replace(/advertis\\w*|sponsored/ig,'').trim().length>15;}catch(_){return true;}}"
    "function clps(e){if(e.__hcc)return;e.__hcc=1;['height','min-height','max-height','margin','padding','border-width']"
    ".forEach(function(p){try{e.style.setProperty(p,'0','important');}catch(_){}});"
    "try{e.style.setProperty('overflow','hidden','important');}catch(_){}}"
    "function collapseSafe(){try{var q=document.querySelectorAll(SAFESEL);for(var i=0;i<q.length;i++){"
    "if(q[i].getBoundingClientRect().height>=30)clps(q[i]);}}catch(_){}}"  // gpt/data slots = always ads
    "function collapseGen(){try{var q=document.querySelectorAll(GENSEL);for(var i=0;i<q.length;i++){"
    "var e=q[i],r=e.getBoundingClientRect();if(r.height>=30&&!substantial(e))clps(e);}}catch(_){}}"
    "function collapseLabeled(){try{var q=document.querySelectorAll('div,aside,section,ins'),c=0;"
    "for(var i=0;i<q.length&&c<450;i++){var e=q[i];if(e.__hcc)continue;var r=e.getBoundingClientRect();"
    "if(r.height<40||r.width<150)continue;c++;if(labeled(e)&&!substantial(e))clps(e);}}catch(_){}}"
    // UNIVERSAL signal (works on any site, no selectors): an EMPTY in-flow box sized to a standard IAB ad
    // slot (728x90, 300x250, 970x250…) is almost certainly an ad. Read all rects first, then collapse, to
    // avoid layout thrash. Post-detection only (bait is tiny/off-screen, never a real in-flow ad size).
    "var IAB=['728x90','970x250','970x90','300x250','336x280','300x600','160x600','320x50','320x100',"
    "'468x60','120x600','300x100','250x250','234x60','300x50','580x400','750x100','750x200','970x66'];"
    "function nearIAB(w,h){for(var i=0;i<IAB.length;i++){var p=IAB[i].split('x');"
    "if(Math.abs(w-(+p[0]))<=3&&Math.abs(h-(+p[1]))<=3)return true;}return false;}"
    "function collapseBySize(){try{var q=document.querySelectorAll('div,aside,section,ins'),hits=[];"
    "for(var i=0;i<q.length&&i<4000;i++){var e=q[i];if(e.__hcc)continue;var r=e.getBoundingClientRect();"
    "if(r.height>=44&&nearIAB(Math.round(r.width),Math.round(r.height)))hits.push(e);}"
    "for(var j=0;j<hits.length;j++)if(!substantial(hits[j]))clps(hits[j]);}catch(_){}}"
    "function collapse(broad){collapseSafe();collapseLabeled();if(broad){collapseGen();collapseBySize();}}"
    "setTimeout(function(){collapse(false);},600);setTimeout(function(){collapse(false);},1500);"
    "setTimeout(function(){collapse(true);},2700);setTimeout(function(){collapse(true);},4500);"
    "setTimeout(function(){collapse(true);},7000);"
    "})();";

// ── EasyList PER-DOMAIN cosmetic rules (the precise, site-specific finish). The heuristic collapser
// handles generic/standard slots; these EasyList rules name each site's REAL ad containers exactly
// (e.g. theverge.com → .m-ad__btf_leaderboard_variable) — specific selectors that hide the slot entirely
// (display:none, no reserved space) and never match a generic detection bait. Loaded once from
// $HOLO_COSMETICS (lines: "domain<TAB>sel1,sel2,…"); the host injects ONLY the current domain's rules per
// page, so it is a tiny per-page CSS string, not a global engine. This is the κ-pinned cosmetic ruleset.
std::unordered_map<std::string, std::string> g_cosmetics;
bool g_cosmetics_loaded = false;

void LoadCosmeticsOnce() {
  if (g_cosmetics_loaded) return;
  g_cosmetics_loaded = true;
  const char* path = std::getenv("HOLO_COSMETICS");
  if (!path || !path[0]) return;
  std::ifstream f(path);
  std::string line;
  g_cosmetics.reserve(8000);
  while (std::getline(f, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t tab = line.find('\t');
    if (tab == std::string::npos) continue;
    g_cosmetics.emplace(line.substr(0, tab), line.substr(tab + 1));
  }
}

std::string HostOfUrl(const std::string& url) {
  const size_t s = url.find("://");
  if (s == std::string::npos) return "";
  const size_t b = s + 3;
  const size_t e = url.find_first_of("/:?#", b);
  std::string h = url.substr(b, (e == std::string::npos ? url.size() : e) - b);
  if (h.rfind("www.", 0) == 0) h = h.substr(4);
  return h;
}

// Gather the matching domain's selectors (walking parent domains so a rule for example.com also covers
// sub.example.com) into one CSS rule, or "" if none.
std::string CosmeticCssFor(const std::string& host) {
  LoadCosmeticsOnce();
  if (g_cosmetics.empty() || host.empty()) return "";
  std::string sels;
  std::string h = host;
  while (true) {
    auto it = g_cosmetics.find(h);
    if (it != g_cosmetics.end()) {
      if (!sels.empty()) sels += ',';
      sels += it->second;
    }
    const size_t dot = h.find('.');
    if (dot == std::string::npos) break;
    const std::string rest = h.substr(dot + 1);
    if (rest.find('.') == std::string::npos) break;  // stop at the registrable domain
    h = rest;
  }
  if (sels.empty()) return "";
  return sels + "{display:none!important}";
}

// Escape a CSS string for embedding as a JS string literal (selectors contain " [ ] * etc.).
std::string JsStr(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (c == '\n' || c == '\r') o += ' ';
    else o += c;
  }
  o += '"';
  return o;
}

// Build the document-start injector that appends the per-domain cosmetic <style> (retries until the DOM
// root exists — same robust pattern as the generic cosmetic).
std::string CosmeticInject(const std::string& css) {
  return "(function(){if(window.__holoCos)return;window.__holoCos=1;var c=" + JsStr(css) +
         ";function add(){if(document.getElementById('holo-cos'))return true;"
         "var p=document.head||document.documentElement;if(!p)return false;"
         "var s=document.createElement('style');s.id='holo-cos';s.textContent=c;p.appendChild(s);return true;}"
         "if(!add()){var n=0,iv=setInterval(function(){if(add()||++n>600)clearInterval(iv);},16);"
         "document.addEventListener('DOMContentLoaded',add);}})();";
}

// shell.html adds `html.native-chrome` (when holo:// && top===self) to HIDE its own tabstrip/nav/omnibox
// for the embedded-in-a-browser case. Shell-is-chrome (the chosen model): the window has NO native toolbar
// or tab strip (the shell view is hosted toolbar-less, CEF_CTT_NONE), so the shell's OWN chrome — INCLUDING
// its tab strip — is the only chrome and the holospace switcher. Strip that class and keep it stripped; the
// shell tabs are real tabs again (no longer retired in favour of native Chromium tabs).
const char kHoloUnchrome[] =
    "(function(){function rm(){try{var d=document.documentElement;if(d)d.classList.remove('native-chrome');}catch(e){}}"
    "var obs=false;function tick(){rm();if(!obs&&document.documentElement){try{"
    "new MutationObserver(rm).observe(document.documentElement,{attributes:true,attributeFilter:['class']});"
    "obs=true;}catch(e){}}}tick();"
    "var n=0,iv=setInterval(function(){tick();if(obs||++n>300)clearInterval(iv);},16);})();";

bool IsHoloFrame(CefRefPtr<CefFrame> frame) {
  const std::string u = frame->GetURL().ToString();
  return u.rfind("holo://", 0) == 0;
}

// "Add to Hologram" — the native store-page affordance. ungoogled/CEF strip the Web Store's own install
// hooks, so its native "Add to Chrome" button is dead; we inject our own. It routes the validated
// extension id to the host (holo:installext), which opens the Extensions manager to do the κ-verified
// install. One gesture, exactly like "Add to Chrome". Returns the trailing [a-p]{32} id, or "" if the
// URL is not a Web Store detail page.
std::string CwsExtId(const std::string& url) {
  if (url.find("chromewebstore.google.com/detail/") == std::string::npos &&
      url.find("chrome.google.com/webstore/detail/") == std::string::npos)
    return "";
  const size_t end = url.find_first_of("?#");
  const std::string u = end == std::string::npos ? url : url.substr(0, end);
  const size_t slash = u.find_last_of('/');
  const std::string seg = slash == std::string::npos ? u : u.substr(slash + 1);
  if (seg.size() != 32) return "";
  for (char c : seg) if (c < 'a' || c > 'p') return "";
  return seg;
}
// Phase-1 rebrand pass for a Web Store detail page (a VIEW transform over Google's page, like the
// no-ads/defuser passes): rewrite the page's own "Add to Chrome" button → "Add to Hologram" and rewire
// its click to the κ-install (holo:installext); replace the "chrome web store" wordmark with "Hologram";
// hide "Switch to Chrome to install"/"Install Chrome" nags. If no native button is found, drop a floating
// "Add to Hologram" (with the H mark) as a guaranteed fallback. document_start + a capped interval +
// debounced MutationObserver cover SPA re-renders without churn.
const char kHoloRebrandTmpl[] =
    "(function(){if(window.__holoRebrand)return;window.__holoRebrand=1;var ID=\"%ID%\";"
    // The ONE canonical Hologram mark — the cube enclosing an H (matches the embedded window icon, the boot
    // splash, and usr/share/icons/holo-glyph.svg). Brand-blue tile, dark cube + dark H. One mark everywhere.
    "var H=\"<svg width='18' height='18' viewBox='0 0 128 128' style='vertical-align:-3px'><rect width='128' height='128' rx='28' fill='#3b82f6'></rect><path d='M64 20 L104 43 V89 L64 112 L24 89 V43 Z' fill='none' stroke='#04101f' stroke-width='8' stroke-linejoin='round'></path><path d='M50 48 V84 M78 48 V84 M50 66 H78' fill='none' stroke='#04101f' stroke-width='10' stroke-linecap='round' stroke-linejoin='round'></path></svg>\";"
    "function toast(m){var t=document.createElement('div');t.textContent=m;t.setAttribute('style','position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);background:#0c1020;color:#eef0fb;border:1px solid #ffffff26;padding:13px 20px;border-radius:12px;font:600 14px system-ui;box-shadow:0 12px 34px #000a;max-width:80vw');document.body.appendChild(t);setTimeout(function(){t.style.transition='opacity .4s';t.style.opacity='0';setTimeout(function(){t.remove();},400);},3600);}"
    "function install(btn){if(btn)btn.textContent='Adding\\u2026';window.cefQuery({request:'holo:installext:'+ID,persistent:false,"
    "onSuccess:function(r){var o={};try{o=JSON.parse(r);}catch(e){}"
    "if(o&&o.ok){if(btn)btn.innerHTML=H+' Added \\u2713';"
    "toast('Added '+(o.name||'extension')+' to Hologram'+(o.needsNative?' \\u00b7 needs native engine':'')+(o.kappa?(' \\u00b7 \\u03ba '+String(o.kappa).slice(0,10)+'\\u2026'):''));}"
    "else if(o&&o.fallback){if(btn)btn.innerHTML=H+' Added \\u2713';}"
    "else{if(btn)btn.textContent='Add to Hologram';toast('Add failed'+(o&&o.error?(': '+o.error):''));}},"
    "onFailure:function(c,m){if(btn)btn.textContent='Add to Hologram';toast('Add failed: '+(m||c));}});}"
    "function pass(){try{"
    "var found=false,nodes=document.querySelectorAll('button,a,[role=button]');"
    "for(var i=0;i<nodes.length;i++){var el=nodes[i],t=(el.textContent||'').trim();"
    "if(/^add to chrome/i.test(t)){found=true;if(!el.__holo){el.__holo=1;el.textContent='Add to Hologram';"
    "el.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();install(this);},true);}}}"
    "var NAG=/switch to chrome|google recommends using chrome|when using extensions and themes|install chrome/i;"
    // PURE-nag only: strip the known nag phrases + non-letters; if almost nothing remains the element is
    // ONLY a nag → safe to hide. The hero (Claude/Anthropic/ratings/Add) always has real text left, so it
    // is never touched. Climb only while the ancestor is STILL pure-nag (never into real content).
    "function pureNag(t){if(!t||!NAG.test(t))return false;var r=t.replace(/switch to chrome\\??/ig,'')"
    ".replace(/google recommends using chrome/ig,'').replace(/to install extensions and themes/ig,'')"
    ".replace(/when using extensions and themes/ig,'').replace(/install chrome/ig,'').replace(/[^a-z]/ig,'');"
    "return r.length<14;}"
    "var ds=document.querySelectorAll('div,section,aside,span,p');"
    "for(var j=0;j<ds.length;j++){var e2=ds[j];if(e2.__hb)continue;if(pureNag(e2.textContent||'')){"
    "var nd=e2;for(var up=0;up<6;up++){var par=nd.parentElement;if(par&&pureNag(par.textContent||''))nd=par;else break;}"
    "nd.__hb=1;nd.style.setProperty('display','none','important');}}"
    "var ws=document.querySelectorAll('a,span,h1,h2,div,p');"
    "for(var k=0;k<ws.length;k++){var e3=ws[k];if(e3.children.length===0){var w=e3.textContent;"
    "if(w&&/^\\s*chrome web store\\s*$/i.test(w)){e3.textContent='Hologram';e3.style.textTransform='none';"
    "var par=e3.parentElement;if(par){var pim=par.querySelectorAll('img,svg');"
    "for(var m=0;m<pim.length;m++){var g=pim[m];if(!g.__hl){g.__hl=1;g.style.display='none';"
    "var sp=document.createElement('span');sp.innerHTML=H;sp.style.cssText='display:inline-flex;margin-right:6px';"
    "if(g.parentNode)g.parentNode.insertBefore(sp,g);}}}}}}"
    "var ims=document.querySelectorAll('img');"
    "for(var z=0;z<ims.length;z++){var im=ims[z];if(!im.__hl&&/chrome web store/i.test(im.alt||'')){"
    "im.__hl=1;im.style.display='none';var s2=document.createElement('span');s2.innerHTML=H;"
    "s2.style.cssText='display:inline-flex;margin-right:6px';if(im.parentNode)im.parentNode.insertBefore(s2,im);}}"
    "if(!found&&!document.getElementById('holo-add-ext')&&document.body){var x=document.createElement('button');"
    "x.id='holo-add-ext';x.innerHTML=H+' Add to Hologram';"
    "x.setAttribute('style','position:fixed;z-index:2147483647;right:18px;bottom:18px;display:inline-flex;gap:7px;align-items:center;padding:12px 18px;border:0;border-radius:12px;background:#3b82f6;color:#04101f;font:600 14px system-ui;cursor:pointer;box-shadow:0 8px 28px #0009');"
    "x.onclick=function(){install(x);};document.body.appendChild(x);}"
    "}catch(e){}}"
    // Staged passes (NOT a continuous MutationObserver — that fights the Web Store's React app and blanks
    // the page). A handful of timed runs catch the content once it renders, then stop. document_start safe.
    "if(document.body)pass();document.addEventListener('DOMContentLoaded',pass);"
    "[300,800,1600,2800,4500,7000,10000].forEach(function(ms){setTimeout(pass,ms);});"
    "})();";
}  // namespace

void SimpleApp::OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  registrar->AddCustomScheme(
      "holo", CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                  CEF_SCHEME_OPTION_CORS_ENABLED | CEF_SCHEME_OPTION_FETCH_ENABLED |
                  // CSP_BYPASSING: a page's Content-Security-Policy (e.g. YouTube's media-src) must not block a
                  // holo:// subresource. holo:// bytes are L5 content-addressed + host-verified, so exempting them
                  // is defensible (same mechanism Chromium grants privileged extension schemes). Unblocks the
                  // YouTube <video> swap and the substrate-on-open-web pattern generally.
                  CEF_SCHEME_OPTION_CSP_BYPASSING);
}

void SimpleApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                              CefRefPtr<CefCommandLine> command_line) {
  if (process_type.empty()) {
    // GPU robustness — the window must NEVER stay blank. History: the 8050S's slow first D3D11 init tripped
    // the GPU watchdog → 3 strikes → GPU disabled; I then over-corrected with --disable-gpu-watchdog +
    // --disable-gpu-process-crash-limit, which DID enable the GPU but REMOVED Chromium's two safety nets,
    // so a runtime GPU stall had no recovery → permanently white window.
    // ROBUST FIX: keep BOTH safety nets ON and only un-blocklist the GPU. Chromium then: uses the GPU when
    // healthy, the WATCHDOG restarts a stalled/lost GPU context (recovers instead of going white), and after
    // repeated GPU failures it FALLS BACK TO SOFTWARE COMPOSITING — which paints unconditionally. Net
    // guarantee: the window always paints; GPU-accelerated whenever the GPU is healthy.
    command_line->AppendSwitch("ignore-gpu-blocklist");
    // KEY: use ANGLE's OpenGL backend, not D3D11. On the 8050S the D3D11 init is slow enough to trip the
    // GPU watchdog (→ GPU disabled → forcing --disable-gpu-watchdog → the blank-window bug). The OpenGL
    // backend inits fast, so the GPU comes up WITH the watchdog active — full acceleration AND recovery.
    // EXCEPTION: the zero-copy OSR projection path (HOLO_OSR_ACCEL=1) needs OnAcceleratedPaint, which on
    // Windows delivers a *D3D11* shared texture — produced only on the ANGLE-D3D11 backend. Under use-angle=gl
    // Chromium composites via GL, no shared texture is made, and CEF silently falls back to software OnPaint
    // (measured: OnAcceleratedPaint never fires). So when accel is explicitly requested, select d3d11; the
    // watchdog + software-compositing fallback stay ON, so the blank-window safety nets are unchanged.
    const char* osr_accel = std::getenv("HOLO_OSR_ACCEL");
    command_line->AppendSwitchWithValue("use-angle", (osr_accel && osr_accel[0] == '1') ? "d3d11" : "gl");
    // Expose a WebGPU adapter to holo:// surfaces (the GPU projection lens: compositing + super-res + warp on
    // the metal). Dawn uses its own backend (D3D12 on Windows), independent of the ANGLE-GL WebGL path above,
    // so this doesn't affect the blank-window stability. Additive.
    command_line->AppendSwitch("enable-unsafe-webgpu");
    // Media: SOUND ON BY DEFAULT. Hologram is a media OS — the user opens a video intentionally, so unmuted
    // autoplay must not need a per-page click gesture (Chromium's default policy otherwise forces MUTED autoplay).
    // With this, a video plays WITH SOUND immediately; the player chrome still offers a mute toggle.
    command_line->AppendSwitchWithValue("autoplay-policy", "no-user-gesture-required");
    // On a host with no hardware WebGPU adapter (a headless/remote CEF launch where requestAdapter()
    // and even forceFallbackAdapter return null), force Dawn's software (SwiftShader) adapter so the
    // GPU projection lens + super-res still render instead of falling back to a plain 2D blit. Opt-in
    // via env so a machine WITH a real GPU keeps hardware acceleration by default.
    if (const char* sw = std::getenv("HOLO_WEBGPU_SWIFTSHADER")) {
      if (sw[0] == '1') command_line->AppendSwitchWithValue("use-webgpu-adapter", "swiftshader");
    }
    if (const char* ext = std::getenv("HOLO_EXTENSIONS")) {
      if (ext[0]) command_line->AppendSwitchWithValue("load-extension", ext);
    }
    // Quiet the Google account surface: no sync + suppress sign-in promos/bubbles (best-effort via flags;
    // the profile avatar button itself is compiled Chrome UI — fully removed in the Phase-3 fork build).
    command_line->AppendSwitch("disable-sync");
    // De-brand: never nag to be the default browser. The "Chromium isn't your default browser / Set as
    // default" infobar (multicolor C logo + text) is the loudest Chromium leak on the login screen. The
    // switch suppresses the runtime check; DefaultBrowserPromptRefresh is the infobar feature itself. The
    // pref browser.default_browser_setting_enabled=false (set in HoloDeferredHostInit) is the belt-and-braces.
    command_line->AppendSwitch("no-default-browser-check");
    command_line->AppendSwitchWithValue(
        "disable-features",
        "SigninPromo,DiceWebSigninInterception,SyncPromoAfterSignin,SigninInterceptBubble,"
        "DefaultBrowserPromptRefresh");
#if !defined(CEF_USE_SANDBOX) && !defined(CEF_USE_BOOTSTRAP)
    // INTERIM (unsandboxed builds only): silence the yellow "unsupported command-line flag: --no-sandbox"
    // bar. It is Chromium's hard-coded bad-flags prompt (bad_flags_prompt.cc), fired because CEF appends
    // --no-sandbox (settings.no_sandbox=true) when the host is built without the sandbox. The bar is NOT a
    // Feature, so disable-features can't reach it; --test-type is the documented suppressor (same switch
    // ChromeDriver uses). The bar TELLS THE TRUTH here, so this only masks it. The real fix — building with
    // USE_SANDBOX (the bootstrap DLL + bootstrap.exe loader) — makes --no-sandbox never appear, so this whole
    // block COMPILES OUT in a sandboxed build (we also don't want test-type's other test-only relaxations on a
    // credential-handling browser). See main.cc / CMakeLists.txt USE_SANDBOX.
    command_line->AppendSwitch("test-type");
#endif
    // First-boot companion tabs (Start here, Play) now open as IN-PAGE holospace tabs via the shell's own
    // window.HoloOpen (handler OnLoadEnd) — not native popups — so the popup blocker no longer matters for
    // boot. Kept off so any gesture-less host-issued open (e.g. a deep-link surface) is never suppressed.
    command_line->AppendSwitch("disable-popup-blocking");
    // SOUND ON BY DEFAULT: Hologram plays media you asked for, so let it autoplay WITH AUDIO without a per-play
    // user gesture (the resolve+transcode takes seconds, by which the original click's gesture has expired →
    // Chromium would otherwise force muted). Holo Video defaults muted=0 and relies on this. Mirrors a media
    // appliance, not a hostile web page; the user can still mute per-video.
    command_line->AppendSwitchWithValue("autoplay-policy", "no-user-gesture-required");
  }
}

// Non-critical host services, run on a posted task AFTER first paint so they never sit on the boot path:
// the loopback WebAuthn step-up broker and the DevTools dock preference. Both are only needed well after the
// login screen is on screen (biometric step-up / F12), so deferring them makes boot leaner without any loss.
static void HoloDeferredHostInit(std::string root, int broker_port) {
  holo::StartBrokerServer(root, broker_port);
  CefRefPtr<CefRequestContext> rc = CefRequestContext::GetGlobalContext();
  if (rc && rc->CanSetPreference("devtools.preferences")) {
    CefRefPtr<CefValue> cur = rc->GetPreference("devtools.preferences");
    CefRefPtr<CefDictionaryValue> dict =
        (cur && cur->GetType() == VTYPE_DICTIONARY) ? cur->GetDictionary()->Copy(false)
                                                    : CefDictionaryValue::Create();
    dict->SetString("currentDockState", "\"right\"");  // F12 docks right at a golden-ratio width
    dict->SetString("InspectorView.splitViewState", "{\"vertical\":{\"size\":733}}");
    CefRefPtr<CefValue> v = CefValue::Create();
    v->SetDictionary(dict);
    CefString err;
    rc->SetPreference("devtools.preferences", v, err);
  }
  // Show Chrome's NATIVE bookmarks bar on all tabs, so the κ bookmarks the Hologram projector writes via
  // chrome.bookmarks are always visible — the "bookmarks row under the address bar", 100% native Chromium.
  if (rc && rc->CanSetPreference("bookmark_bar.show_on_all_tabs")) {
    CefRefPtr<CefValue> bb = CefValue::Create();
    bb->SetBool(true);
    CefString e2;
    rc->SetPreference("bookmark_bar.show_on_all_tabs", bb, e2);
  }
  // De-brand belt-and-braces: turn the default-browser setting OFF as a pref too, so even if the feature
  // flag path changes between Chromium versions the "Chromium isn't your default browser" infobar never
  // appears. Pairs with --no-default-browser-check + disable DefaultBrowserPromptRefresh (OnBeforeCommandLine).
  if (rc && rc->CanSetPreference("browser.default_browser_setting_enabled")) {
    CefRefPtr<CefValue> db = CefValue::Create();
    db->SetBool(false);
    CefString e3;
    rc->SetPreference("browser.default_browser_setting_enabled", db, e3);
  }
  // ── Unify-the-chrome (Strategy A): make the native omnibox κ-smart by pointing its free-text/search path
  // at the holo resolver. Anything Chromium treats as a search (a name, three words, a κ, free text) then
  // arrives as holo://os/omni?q=<raw>, which OnBeforeBrowse holds + resolves through holo-omni-resolve.
  // NOTE (verify at build): the settable pref key for the default search provider is Chromium-version
  // dependent ("default_search_provider_data.template_url_data" in current builds). It is guarded by
  // CanSetPreference and fail-soft — if this CEF/Chromium doesn't expose it, the omni interception simply
  // lies dormant for the NATIVE bar; the in-page home-hero omnibox still feeds the SAME route by navigating
  // to holo://os/omni?q=<input> directly (Phase 1), so the resolver path is exercised either way.
  if (rc && rc->CanSetPreference("default_search_provider_data.template_url_data")) {
    CefRefPtr<CefDictionaryValue> turl = CefDictionaryValue::Create();
    turl->SetString("short_name", "Hologram");
    turl->SetString("keyword", "holo");
    turl->SetString("url", "holo://os/omni?q={searchTerms}");
    // New Tab Page → Hologram home/launcher. The default search provider's new_tab_url is what chrome-runtime
    // navigates a fresh tab to (instead of chrome://new-tab-page-third-party). chrome already accepts our
    // holo:// search url above, so point the NTP at the Hologram home — new tabs open the launcher, not Google.
    turl->SetString("new_tab_url", "holo://os/home.html");
    turl->SetBool("safe_for_autoreplace", false);
    CefRefPtr<CefValue> v = CefValue::Create();
    v->SetDictionary(turl);
    CefString e4;
    rc->SetPreference("default_search_provider_data.template_url_data", v, e4);
  }
}

void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  std::string root = "dist";
  if (const char* env = std::getenv("HOLO_OS_DIR")) root = env;
  // Trust root = the baked anchor (sha256 of the shipped os-closure.json) by default. But the local
  // operator reseals dist as they develop, which would (correctly) fail-close this host on a stale
  // baked value. So allow a launch-time override: HOLO_CLOSURE_ANCHOR=<hex> tracks the freshly-sealed
  // dist without a rebuild; HOLO_CLOSURE_ANCHOR="" skips the manifest check (path-trust). Either way,
  // per-file L5 (every served byte must re-derive to its pinned κ) is still enforced by the verifier.
  // Live-anchor hot-reload: a HotStore watches dist/os-closure.json and re-opens the sealed image whenever
  // the operator reseals during dev — the running browser absorbs a reseal in ~400ms instead of being
  // poisoned (stale anchor → 403) until relaunch. The watcher derives the anchor live from the file, so the
  // HOLO_CLOSURE_ANCHOR baked/env plumbing is no longer consulted for the scheme store. Per-byte L5 unchanged.
  static HotStore* g_store = new HotStore(root);  // owns the watcher thread for the process lifetime
  CefRegisterSchemeHandlerFactory("holo", CefString(), new KappaSchemeHandlerFactory(g_store));

  // Bring the planetary content network up automatically — no user input. Spawns + supervises the always-on
  // mesh node (serves the shared dir to peers + is kr_mesh_get's gateway on 127.0.0.1:9802). Dormant + harmless
  // if the sidecar isn't staged; the browser never blocks on it (origin is always the floor).
  StartMeshSupervisor();

  // INSTANT BOOT — boot the window + canonical login FIRST, before any non-critical init, so first paint is
  // never blocked behind the broker socket bind or DevTools preference writes. The boot-critical path is now
  // just: register the κ scheme (above) + open the canonical login (here). Everything else is deferred below.
  std::string url = "holo://os/login";   // the CLEAN address: the chrome-runtime omnibox shows this verbatim
                                          // (the scheme canonicalizes os/login → os/login.html — same bytes, clean
                                          // bar). Host stays "os" so the same-origin OS model is untouched.
  if (const char* u = std::getenv("HOLO_START_URL")) url = u;

  CefRefPtr<SimpleHandler> handler(new SimpleHandler());
  // Boot through the boot-health supervisor (SimpleHandler::StartBoot): one window, the canonical login, and
  // if a window strategy collapses it self-heals to the proven native-hosted window instead of vanishing.
  handler->StartBoot(url);

  // Non-critical host services, woken AFTER first paint (off the boot-critical path): the loopback WebAuthn
  // step-up broker (only needed once the user does biometric step-up) and the DevTools dock preference (only
  // read on F12). Deferred so they never sit between launch and the login screen. See HoloDeferredHostInit.
  int broker_port = 8495;
  if (const char* bp = std::getenv("HOLO_BROKER_PORT")) { const int v = std::atoi(bp); if (v > 0 && v < 65536) broker_port = v; }
  CefPostDelayedTask(TID_UI, base::BindOnce(&HoloDeferredHostInit, root, broker_port), 1200);
}

void SimpleApp::OnWebKitInitialized() {
  CefMessageRouterConfig config;  // default window.cefQuery / window.cefQueryCancel
  render_router_ = CefMessageRouterRendererSide::Create(config);
}

void SimpleApp::OnContextCreated(CefRefPtr<CefBrowser> browser,
                                 CefRefPtr<CefFrame> frame,
                                 CefRefPtr<CefV8Context> context) {
  render_router_->OnContextCreated(browser, frame, context);
  // Origin-tiered: only holo:// frames receive the Hologram bridge. Web frames get nothing.
  if (IsHoloFrame(frame)) {
    frame->ExecuteJavaScript(kHoloBridgeShim, frame->GetURL(), 0);
    // The privileged service runs only in the OS home frame (the shell). Other holo:// frames (apps)
    // get the bridge but reach the service through the relay, never host it themselves.
    const std::string fu = frame->GetURL().ToString();
    // The committed URL is what was navigated to (holo://os/home), not the canonical bytes path — so match the
    // CLEAN short form too, exactly (not "holo://os/home-screen"), alongside the legacy holo://os/shell|home.html.
    const bool is_shell = (fu == "holo://os/home" || fu.rfind("holo://os/home?", 0) == 0 || fu.rfind("holo://os/home/", 0) == 0 ||
                           fu.rfind("holo://os/shell", 0) == 0 || fu.rfind("holo://os/home.", 0) == 0);
    if (frame->IsMain() && is_shell) {
      frame->ExecuteJavaScript(kHoloServiceShim, frame->GetURL(), 0);
      frame->ExecuteJavaScript(kHoloUnchrome, frame->GetURL(), 0);  // show the FULL Hologram shell chrome
    }
    // Holo DevTools dock (ADR-0095): every APP tab (holo://<κ>/ — a top-level κ-holospace with no shell
    // parent) gets the right-docked inspector by injecting the boot MODULE. Skip the shell (it installs its
    // own dock). Our own holo:// pages have no hostile CSP, so a holo://os module <script> loads fine
    // (cross-origin, host-granted ACAO for the devtools graph). F12 in the host routes to HoloDevDock.toggle.
    // (Holo DevTools in-page dock injection removed by request — F12 opens the standard detached
    // Chromium DevTools window via OnKeyEvent/ShowHoloDevTools instead of an in-page slide-out box.)
  } else {
    // Web page: collapse leftover ad placeholders so the page re-flows ad-free (cosmetic complement to
    // the network block in handler.cc). The bridge/service are never injected here (origin tier holds).
    // At context-creation the frame URL can be empty/about:blank for a web nav still committing, so we
    // also inject on empty; chrome://newtab and friends are harmless (the selectors match nothing there).
    const std::string u = frame->GetURL().ToString();
    if (u.empty() || u.rfind("http", 0) == 0) {
      frame->ExecuteJavaScript(kHoloNoAdsCss, frame->GetURL(), 0);
      frame->ExecuteJavaScript(kHoloDefuserJs, frame->GetURL(), 0);  // anti-anti-adblock last resort
      // EasyList per-domain cosmetic rules for THIS site (precise, hides the real ad containers entirely).
      const std::string css = CosmeticCssFor(HostOfUrl(u));
      if (!css.empty()) frame->ExecuteJavaScript(CosmeticInject(css), frame->GetURL(), 0);
    }
    // Holo Playground: make EVERY element on EVERY real page editable on screen. Injected as host V8 execution
    // in the page's MAIN WORLD, which BYPASSES the page CSP (a holo:// <script> is refused by sites like HN /
    // Google — proven). The bundle is fully self-contained (esbuild IIFE, no import/fetch), DORMANT until the
    // top-right ✦ launcher arms it; its edits mint a snapshot κ. Main frame only (never ad/sub frames), and
    // never holo:// (the OS shell runs its own Playground). The boot self-defers until document.body exists.
    if (frame->IsMain() && (u.empty() || u.rfind("http", 0) == 0 || u.rfind("file:", 0) == 0)) {
      frame->ExecuteJavaScript(kHoloPlaygroundBundle, frame->GetURL(), 0);
      // Holo Messenger capture (Phase 7): same CSP-proof host-inject path. Self-gates to messenger
      // hosts (web.whatsapp.com / web.telegram.org / discord.com / app.slack.com / …); inert elsewhere.
      // Posts raw captured message fields on the "holo-messenger" BroadcastChannel → the inbox mints + ingests.
      frame->ExecuteJavaScript(kHoloMessengerCaptureBundle, frame->GetURL(), 0);
      // YouTube: this CEF lacks H.264/AAC so YouTube's MSE player shows "can't play"; the shim swaps the dead
      // player for a native <video src=holo://os/sc/vstream…> (VP9/Opus, engine-decodable — PROVEN). Self-gates
      // to youtube.com, inert elsewhere. The holo:// media load needs CEF_SCHEME_OPTION_CSP_BYPASSING (below).
      frame->ExecuteJavaScript(kHoloYoutubeBundle, frame->GetURL(), 0);
      frame->ExecuteJavaScript(kHoloWebAuthn, frame->GetURL(), 0);  // passkey provider on web frames
      frame->ExecuteJavaScript(kHoloCred, frame->GetURL(), 0);  // web2 autofill/save/totp (unified credential relay)
    }
    // Web Store detail page → rebrand it to Hologram (relabel "Add to Chrome", wordmark, nags) + the
    // κ-install affordance (only the real CWS host, main frame).
    const std::string xid = CwsExtId(u);
    if (!xid.empty() && frame->IsMain()) {
      std::string js(kHoloRebrandTmpl);
      const std::string ph = "%ID%";
      const size_t p = js.find(ph);
      if (p != std::string::npos) js.replace(p, ph.size(), xid);
      frame->ExecuteJavaScript(js, frame->GetURL(), 0);
    }
  }
}

void SimpleApp::OnContextReleased(CefRefPtr<CefBrowser> browser,
                                  CefRefPtr<CefFrame> frame,
                                  CefRefPtr<CefV8Context> context) {
  render_router_->OnContextReleased(browser, frame, context);
}

bool SimpleApp::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                         CefRefPtr<CefFrame> frame,
                                         CefProcessId source_process,
                                         CefRefPtr<CefProcessMessage> message) {
  return render_router_->OnProcessMessageReceived(browser, frame, source_process, message);
}
