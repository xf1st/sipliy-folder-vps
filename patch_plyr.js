const fs = require('fs');
let lines = fs.readFileSync('app/server.js', 'utf8').split('\n');

// ── 1. Replace the media-viewer HTML (line 2764–2768) ──
// Find it by content
const htmlMarker = `  '<div id="media-viewer" class="media-viewer">' +`;
const htmlIdx = lines.findIndex(l => l.trim().startsWith(`'<div id="media-viewer"`));
console.log('HTML line:', htmlIdx + 1, lines[htmlIdx]);

const htmlEnd = htmlIdx + 4; // 5 lines: 2764..2768
console.log('HTML end line:', htmlEnd + 1, lines[htmlEnd]);

const newHtml = [
  `  '<div id="media-viewer" class="media-viewer">' +`,
  `  '  <div class="mv-top">' +`,
  `  '    <div id="mv-title" class="mv-title">Media</div>' +`,
  `  '    <button class="mv-icon" data-action="mv-download" title="Скачать"><span class="material-symbols-outlined">download</span></button>' +`,
  `  '    <button class="mv-icon" data-action="mv-share" title="Публичная ссылка"><span class="material-symbols-outlined">link</span></button>' +`,
  `  '    <button class="mv-icon" data-action="mv-close" title="Закрыть"><span class="material-symbols-outlined">close</span></button>' +`,
  `  '  </div>' +`,
  `  '  <div id="mv-stage" class="mv-stage"></div>' +`,
  `  '</div>' +`,
];
lines.splice(htmlIdx, htmlEnd - htmlIdx + 1, ...newHtml);
console.log('HTML replaced. Lines now:', lines.length);

// Re-read after splice offset
const offset = newHtml.length - (htmlEnd - htmlIdx + 1);

// ── 2. Replace closeMediaViewer + openMediaViewer + bindMediaControls + mediaViewerAction ──
// Find 'window.plyrInstance = null;' which precedes closeMediaViewer
const plyrNullIdx = lines.findIndex(l => l.trim() === `'window.plyrInstance = null;' +`);
console.log('plyrNull line:', plyrNullIdx + 1);

// Find end marker: line after 'function mediaViewerAction...'
const mvActionIdx = lines.findIndex(l => l.includes('function mediaViewerAction(action)'));
console.log('mvAction line:', mvActionIdx + 1);

if (plyrNullIdx === -1 || mvActionIdx === -1) {
  console.log('MARKER NOT FOUND'); process.exit(1);
}

const newJs = [
  `  'window.plyrInstance = null;' +`,
  ``,
  `  /* ── MEDIA VIEWER (full-screen) ── */`,
  `  'function _mvDestroyPlyr(){' +`,
  `  '  if(window.plyrInstance){' +`,
  `  '    try{ window.plyrInstance.pause(); }catch(e){}' +`,
  `  '    try{ window.plyrInstance.destroy(); }catch(e){}' +`,
  `  '    window.plyrInstance=null;' +`,
  `  '  }' +`,
  `  '  var old=document.getElementById("mv-media");' +`,
  `  '  if(old && old.pause) old.pause();' +`,
  `  '}' +`,
  `  'function closeMediaViewer(){' +`,
  `  '  _mvDestroyPlyr();' +`,
  `  '  var v=document.getElementById("media-viewer");' +`,
  `  '  v.classList.remove("open");' +`,
  `  '  document.getElementById("mv-stage").innerHTML="";' +`,
  `  '}' +`,
  `  'function openMediaViewer(){' +`,
  `  '  if(!previewSrc||!previewKind)return;' +`,
  `  '  _mvDestroyPlyr();' +`,
  `  '  var v=document.getElementById("media-viewer");' +`,
  `  '  var stage=document.getElementById("mv-stage");' +`,
  `  '  document.getElementById("mv-title").textContent=previewName||"Media";' +`,
  `  '  stage.innerHTML="";' +`,
  `  '  if(previewKind==="image"){' +`,
  `  '    var img=document.createElement("img");' +`,
  `  '    img.src=previewSrc; img.style.cssText="max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;";' +`,
  `  '    stage.appendChild(img);' +`,
  `  '    v.classList.add("open");' +`,
  `  '    return;' +`,
  `  '  }' +`,
  `  '  var tag=previewKind==="audio"?"audio":"video";' +`,
  `  '  var el=document.createElement(tag);' +`,
  `  '  el.id="mv-media"; el.src=previewSrc; el.setAttribute("playsinline","");' +`,
  `  '  el.style.cssText="max-height:100%;width:100%;display:block;";' +`,
  `  '  stage.appendChild(el);' +`,
  `  '  v.classList.add("open");' +`,
  `  '  var _src=previewSrc, _kind=previewKind;' +`,
  `  '  var _attempts=0;' +`,
  `  '  var _init=function(){' +`,
  `  '    _attempts++;' +`,
  `  '    if(typeof Plyr==="undefined"){' +`,
  `  '      if(_attempts<40){ setTimeout(_init, 150); } else { console.warn("Plyr never loaded"); }' +`,
  `  '      return;' +`,
  `  '    }' +`,
  `  '    var mediaEl=document.getElementById("mv-media");' +`,
  `  '    if(!mediaEl){ if(_attempts<20){ setTimeout(_init,100); } return; }' +`,
  `  '    try{' +`,
  `  '      var isVid=_kind==="video";' +`,
  `  '      window.plyrInstance=new Plyr(mediaEl,{' +`,
  `  '        controls: isVid' +`,
  `  '          ? ["play-large","play","progress","current-time","duration","mute","volume","settings","fullscreen"]' +`,
  `  '          : ["play","progress","current-time","duration","mute","volume"],' +`,
  `  '        settings: ["speed","loop"],' +`,
  `  '        keyboard: {focused:true, global:false},' +`,
  `  '        fullscreen: {enabled:true, fallback:true, iosNative:true},' +`,
  `  '        storage: {enabled:true, key:"plyrCloudVol"}' +`,
  `  '      });' +`,
  `  '      window.plyrInstance.on("ready", function(){' +`,
  `  '        var t=localStorage.getItem("plyr_t_"+_src);' +`,
  `  '        if(t) window.plyrInstance.currentTime=parseFloat(t);' +`,
  `  '      });' +`,
  `  '      window.plyrInstance.on("timeupdate", function(){' +`,
  `  '        if(window.plyrInstance) localStorage.setItem("plyr_t_"+_src, window.plyrInstance.currentTime);' +`,
  `  '      });' +`,
  `  '    } catch(err){ console.error("Plyr cloud init:", err); }' +`,
  `  '  };' +`,
  `  '  setTimeout(_init, 100);' +`,
  `  '}' +`,
  `  'function bindMediaControls(){}' +`,
  `  'function mediaViewerAction(action){' +`,
  `  '  if(action==="mv-close") return closeMediaViewer();' +`,
  `  '  if(action==="mv-download" && previewFp) window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);' +`,
  `  '  if(action==="mv-share" && previewFp) shareOne(previewFp);' +`,
  `  '}' +`,
];

lines.splice(plyrNullIdx, mvActionIdx - plyrNullIdx + 1, ...newJs);
console.log('JS replaced. Lines now:', lines.length);

fs.writeFileSync('app/server.js', lines.join('\n'));
console.log('DONE');
