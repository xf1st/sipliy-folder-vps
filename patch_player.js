const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'app', 'server.js');
let content = fs.readFileSync(targetFile, 'utf8');

const lines = content.split('\n');
let patchedCount = 0;

let inStyleBlock = false;
let inMobileTopbar = false;
let inSidebarNav = false;
let foundCloseQr = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // 1. CSS Injection state machine
  if (line.includes('.modal-backdrop{align-items:flex-end!important;padding:10px!important}')) {
    inStyleBlock = true;
  }
  if (inStyleBlock && line.includes('</style>')) {
    const target = "'</style>' +";
    const replacement = "'#sidebar-player{display:none;margin:12px 8px;padding:14px;border-radius:20px;background:var(--surf-hi);border:1px solid color-mix(in srgb,var(--accent-color) 15%,rgba(255,255,255,.05));box-shadow:0 8px 32px rgba(0,0,0,.24);flex-direction:column;gap:10px;animation:slideUpFade 0.4s var(--m3-spring) both}' +\n" +
      "  '@keyframes slideUpFade{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}' +\n" +
      "  '.player-cover-art{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent-color),color-mix(in srgb,var(--accent-color) 40%,#000));display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 4px 14px var(--accent-glow)}' +\n" +
      "  '.player-ctrl-btn{width:34px!important;height:34px!important;min-height:34px!important;padding:0!important;border-radius:50%!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;transition:transform 0.2s,background 0.2s!important}' +\n" +
      "  '.player-ctrl-btn:hover{transform:scale(1.1);background:rgba(255,255,255,0.08)!important}' +\n" +
      "  '.player-play-btn{width:40px;height:40px;border-radius:50%;background:var(--accent-color);color:#fff;border:none;outline:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px var(--accent-glow);transition:transform 0.25s var(--m3-spring),box-shadow 0.2s}' +\n" +
      "  '.player-play-btn:hover{transform:scale(1.12);box-shadow:0 8px 24px var(--accent-glow)}' +\n" +
      "  '.player-play-btn:active{transform:scale(0.95)}' +\n" +
      "  '#player-progress{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.12);outline:none;cursor:pointer;accent-color:var(--accent-color);transition:height 0.15s}' +\n" +
      "  '#player-progress:hover{height:6px}' +\n" +
      "  '#player-progress::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--accent-color);cursor:pointer;box-shadow:0 0 8px var(--accent-glow);transition:transform 0.15s}' +\n" +
      "  '#player-progress:hover::-webkit-slider-thumb{transform:scale(1.3)}' +\n" +
      "  '.playlist-track-row:hover{background:rgba(255,255,255,0.05)!important}' +\n  '</style>' +";
    lines[i] = line.replace(target, replacement);
    console.log("✓ CSS successfully inserted!");
    patchedCount++;
    inStyleBlock = false;
  }

  // 2. Hide Mobile Search Button state machine
  if (line.includes('<header class="mobile-topbar">')) {
    inMobileTopbar = true;
  }
  if (inMobileTopbar && line.includes('focus-search')) {
    lines[i] = ''; // remove button line
    console.log("✓ Mobile Search Button successfully removed!");
    patchedCount++;
    inMobileTopbar = false;
  }

  // 3. Insert Sidebar Player HTML Layout state machine
  if (line.includes('data-action="nav-settings"') && line.includes('Настройки')) {
    inSidebarNav = true;
  }
  if (inSidebarNav && line.includes('flex:1')) {
    const target = "'<div style=\"flex:1\"></div>' +";
    const replacement = "'<div style=\"flex:1\"></div>' +\n" +
      "  '<audio id=\"global-audio\" style=\"display:none\"></audio>' +\n" +
      "  '<div id=\"sidebar-player\" class=\"card\">' +\n" +
      "  '  <div style=\"display:flex;align-items:center;gap:12px;position:relative\">' +\n" +
      "  '    <div class=\"player-cover-art\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" style=\"font-size:24px\">music_note</span>' +\n" +
      "  '    </div>' +\n" +
      "  '    <div id=\"player-text-wrap\" style=\"min-width:0;flex:1;cursor:pointer;margin-right:48px\" title=\"Нажмите, чтобы поменять местами Название и Исполнителя\">' +\n" +
      "  '      <div id=\"player-title\" style=\"font-size:13px;font-weight:800;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2\">—</div>' +\n" +
      "  '      <div id=\"player-artist\" style=\"font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;margin-top:2px\">—</div>' +\n" +
      "  '    </div>' +\n" +
      "  '    <div style=\"position:absolute;right:-4px;top:-4px;display:flex;align-items:center;gap:2px\">' +\n" +
      "  '      <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-details\" title=\"Открыть детали файла\" style=\"width:24px!important;height:24px!important;min-height:24px!important\">' +\n" +
      "  '        <span class=\"material-symbols-outlined\" style=\"font-size:15px\">info</span>' +\n" +
      "  '      </button>' +\n" +
      "  '      <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-close\" title=\"Скрыть плеер\" style=\"width:24px!important;height:24px!important;min-height:24px!important\">' +\n" +
      "  '        <span class=\"material-symbols-outlined\" style=\"font-size:15px\">close</span>' +\n" +
      "  '      </button>' +\n" +
      "  '    </div>' +\n" +
      "  '  </div>' +\n" +
      "  '  <div style=\"display:flex;flex-direction:column;gap:4px;margin-top:2px\">' +\n" +
      "  '    <input type=\"range\" id=\"player-progress\" min=\"0\" max=\"100\" value=\"0\">' +\n" +
      "  '    <div style=\"display:flex;justify-content:space-between;font-size:10px;color:#958ea0;font-weight:700\">' +\n" +
      "  '      <span id=\"player-time-cur\">0:00</span>' +\n" +
      "  '      <span id=\"player-time-dur\">0:00</span>' +\n" +
      "  '    </div>' +\n" +
      "  '  </div>' +\n" +
      "  '  <div style=\"display:flex;align-items:center;justify-content:center;gap:10px;margin-top:2px\">' +\n" +
      "  '    <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-repeat\" title=\"Повтор\" style=\"color:var(--outline)\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" style=\"font-size:20px\">repeat</span>' +\n" +
      "  '    </button>' +\n" +
      "  '    <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-prev\" title=\"Предыдущий трек\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" style=\"font-size:22px\">skip_previous</span>' +\n" +
      "  '    </button>' +\n" +
      "  '    <button class=\"player-play-btn\" id=\"player-btn-play\" title=\"Воспроизведение\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" id=\"player-play-icon\" style=\"font-size:24px\">play_arrow</span>' +\n" +
      "  '    </button>' +\n" +
      "  '    <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-next\" title=\"Следующий трек\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" style=\"font-size:22px\">skip_next</span>' +\n" +
      "  '    </button>' +\n" +
      "  '    <button class=\"btn-ghost player-ctrl-btn\" id=\"player-btn-playlist\" title=\"Очередь воспроизведения\">' +\n" +
      "  '      <span class=\"material-symbols-outlined\" style=\"font-size:20px\">playlist_play</span>' +\n" +
      "  '    </button>' +\n" +
      "  '  </div>' +\n" +
      "  '</div>' +";
    lines[i] = line.replace(target, replacement);
    console.log("✓ Sidebar HTML inserted!");
    patchedCount++;
    inSidebarNav = false;
  }

  // 3.1. Insert Playlist Modal HTML Next to existing modals
  if (line.includes('data-action="close-qr"')) {
    foundCloseQr = true;
  }
  if (foundCloseQr && line.includes('\'</div></div></div>\' +')) {
    const target = "'</div></div></div>' +";
    const replacement = "'</div></div></div>' +\n" +
      "  '<div id=\"modal-playlist\" class=\"modal-backdrop\" style=\"display:none\">' +\n" +
      "  '<div class=\"modal\" style=\"width:min(500px,94vw);max-height:80vh;display:flex;flex-direction:column;padding:20px;border-radius:24px;background:var(--surf-hi);border:1px solid rgba(255,255,255,.05)\">' +\n" +
      "  '  <div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px\">' +\n" +
      "  '    <span class=\"material-symbols-outlined\" style=\"color:var(--accent-color);font-size:26px\">queue_music</span>' +\n" +
      "  '    <div style=\"font-weight:800;font-size:18px;color:var(--on-surf);flex:1\">Очередь воспроизведения</div>' +\n" +
      "  '    <button class=\"btn-ghost\" id=\"playlist-modal-close\" style=\"padding:4px 8px;font-size:14px;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center\"><span class=\"material-symbols-outlined\" style=\"font-size:20px\">close</span></button>' +\n" +
      "  '  </div>' +\n" +
      "  '  <div id=\"playlist-modal-tracks\" style=\"flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;max-height:50vh\"></div>' +\n" +
      "  '</div></div>' +";
    lines[i] = line.replace(target, replacement);
    console.log("✓ Playlist Modal HTML successfully inserted!");
    patchedCount++;
    foundCloseQr = false;
  }

  // 4. Hide Search bar in updateSmartToolbar
  if (line.includes('setSmartVisible(search,isFiles,"block");')) {
    lines[i] = line.replace('setSmartVisible(search,isFiles,"block");', 'setSmartVisible(search,false,"block");');
    console.log("✓ Search bar hidden in Files View!");
    patchedCount++;
  }

  // 5. Variables in client-side script
  if (line.includes('var previewFp=""') && line.includes('previewKind=""') && !line.includes('activeAudioFp')) {
    const target = "'var previewFp=\"\",previewName=\"\",previewKind=\"\",previewSrc=\"\",mvZoom=1;' +";
    const replacement = "'var previewFp=\"\",previewName=\"\",previewKind=\"\",previewSrc=\"\",mvZoom=1;' +\n  'var activeAudioFp=\"\",activeAudioName=\"\",currentAudioQueue=[],sidebarPlayerInitialized=false;' +";
    lines[i] = line.replace(target, replacement);
    console.log("✓ Variables inserted!");
    patchedCount++;
  }

  // 6. Playback Controller functions after initPlyr
  if (line.includes('function initPlyr(selector,isVideo,key,startTime,autoPlay){') && line.includes('playSibling("next",true)')) {
    const replacement = line + "\n" +
      "  'function playGlobalAudio(fp,name,forcePlay){' +\n" +
      "  '  var audio=document.getElementById(\"global-audio\");' +\n" +
      "  '  if(!audio)return;' +\n" +
      "  '  activeAudioFp=fp;activeAudioName=name;' +\n" +
      "  '  if(!window.sidebarPlayerInitialized){initSidebarPlayer();}' +\n" +
      "  '  var playerCard=document.getElementById(\"sidebar-player\");' +\n" +
      "  '  if(playerCard)playerCard.style.display=\"flex\";' +\n" +
      "  '  updatePlayerTrackInfo();' +\n" +
      "  '  var src=\"/api/fm/preview?path=\"+encodeURIComponent(fp);' +\n" +
      "  '  if(audio.src!==window.location.origin+src&&audio.getAttribute(\"src\")!==src){audio.src=src;}' +\n" +
      "  '  buildAudioQueue();' +\n" +
      "  '  if(forcePlay){' +\n" +
      "  '    audio.play().catch(function(e){console.error(\"Audio play error:\",e);});' +\n" +
      "  '    updatePlayButtonState(true);' +\n" +
      "  '  }else{' +\n" +
      "  '    audio.pause();updatePlayButtonState(false);' +\n" +
      "  '  }' +\n" +
      "  '}' +\n" +
      "  'function updatePlayerTrackInfo(){' +\n" +
      "  '  var name=activeAudioName;' +\n" +
      "  '  if(!name)return;' +\n" +
      "  '  var titleEl=document.getElementById(\"player-title\");' +\n" +
      "  '  var artistEl=document.getElementById(\"player-artist\");' +\n" +
      "  '  var baseName=name.replace(/\\\\.[^/.]+$/,\"\");' +\n" +
      "  '  var parts=baseName.split(\" - \");' +\n" +
      "  '  var title=baseName;' +\n" +
      "  '  var artist=\"CloudSpace\";' +\n" +
      "  '  var swap=localStorage.getItem(\"player-swap-fields\")===\"true\";' +\n" +
      "  '  if(parts.length>1){' +\n" +
      "  '    var p0=parts[0].trim();' +\n" +
      "  '    var p1=parts.slice(1).join(\" - \").trim();' +\n" +
      "  '    if(swap){' +\n" +
      "  '      title=p0;artist=p1;' +\n" +
      "  '    }else{' +\n" +
      "  '      title=p1;artist=p0;' +\n" +
      "  '    }' +\n" +
      "  '  }' +\n" +
      "  '  if(titleEl)titleEl.textContent=title;' +\n" +
      "  '  if(artistEl)artistEl.textContent=artist;' +\n" +
      "  '}' +\n" +
      "  'function buildAudioQueue(){' +\n" +
      "  '  currentAudioQueue=[];' +\n" +
      "  '  var exts=[\"mp3\",\"wav\",\"m4a\",\"flac\",\"aac\",\"oga\"];' +\n" +
      "  '  for(var i=0;i<lastEntries.length;i++){' +\n" +
      "  '    var entry=lastEntries[i];' +\n" +
      "  '    if(entry.isDir)continue;' +\n" +
      "  '    var ext=(entry.name.split(\".\").pop()||\"\").toLowerCase();' +\n" +
      "  '    if(exts.includes(ext)){' +\n" +
      "  '      var entryPath=lastBase?(lastBase+\"/\"+entry.name):entry.name;' +\n" +
      "  '      currentAudioQueue.push({fp:entryPath,name:entry.name});' +\n" +
      "  '    }' +\n" +
      "  '  }' +\n" +
      "  '}' +\n" +
      "  'function prevGlobalTrack(){' +\n" +
      "  '  if(!currentAudioQueue.length)return;' +\n" +
      "  '  var idx=-1;' +\n" +
      "  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +\n" +
      "  '  if(idx===-1)return;' +\n" +
      "  '  var prevIdx=idx-1;' +\n" +
      "  '  if(prevIdx<0){' +\n" +
      "  '    prevIdx=currentAudioQueue.length-1;' +\n" +
      "  '  }' +\n" +
      "  '  var track=currentAudioQueue[prevIdx];' +\n" +
      "  '  playGlobalAudio(track.fp,track.name,true);' +\n" +
      "  '}' +\n" +
      "  'function nextGlobalTrack(isAuto){' +\n" +
      "  '  if(!currentAudioQueue.length)return;' +\n" +
      "  '  var idx=-1;' +\n" +
      "  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +\n" +
      "  '  if(idx===-1)return;' +\n" +
      "  '  var repeat=localStorage.getItem(\"player-repeat-mode\")||\"off\";' +\n" +
      "  '  if(isAuto&&repeat===\"one\"){' +\n" +
      "  '    playGlobalAudio(activeAudioFp,activeAudioName,true);' +\n" +
      "  '    return;' +\n" +
      "  '  }' +\n" +
      "  '  var nextIdx=idx+1;' +\n" +
      "  '  if(nextIdx>=currentAudioQueue.length){' +\n" +
      "  '    if(isAuto&&repeat===\"off\"){' +\n" +
      "  '      updatePlayButtonState(false);' +\n" +
      "  '      return;' +\n" +
      "  '    }' +\n" +
      "  '    nextIdx=0;' +\n" +
      "  '  }' +\n" +
      "  '  var track=currentAudioQueue[nextIdx];' +\n" +
      "  '  playGlobalAudio(track.fp,track.name,true);' +\n" +
      "  '}' +\n" +
      "  'function toggleGlobalPlay(){' +\n" +
      "  '  var audio=document.getElementById(\"global-audio\");' +\n" +
      "  '  if(!audio)return;' +\n" +
      "  '  if(audio.paused){' +\n" +
      "  '    audio.play().then(function(){updatePlayButtonState(true);}).catch(function(e){console.error(e);});' +\n" +
      "  '  }else{' +\n" +
      "  '    audio.pause();updatePlayButtonState(false);' +\n" +
      "  '  }' +\n" +
      "  '}' +\n" +
      "  'function updatePlayButtonState(isPlaying){' +\n" +
      "  '  var icon=document.getElementById(\"player-play-icon\");' +\n" +
      "  '  if(icon)icon.textContent=isPlaying?\"pause\":\"play_arrow\";' +\n" +
      "  '  var btn=document.getElementById(\"player-btn-play\");' +\n" +
      "  '  if(btn)btn.title=isPlaying?\"Пауза\":\"Воспроизведение\";' +\n" +
      "  '}' +\n" +
      "  'function toggleRepeatMode(){' +\n" +
      "  '  var repeat=localStorage.getItem(\"player-repeat-mode\")||\"off\";' +\n" +
      "  '  var nextRepeat=\"off\";' +\n" +
      "  '  if(repeat===\"off\")nextRepeat=\"all\";' +\n" +
      "  '  else if(repeat===\"all\")nextRepeat=\"one\";' +\n" +
      "  '  localStorage.setItem(\"player-repeat-mode\",nextRepeat);' +\n" +
      "  '  updateRepeatButtonUI();' +\n" +
      "  '}' +\n" +
      "  'function updateRepeatButtonUI(){' +\n" +
      "  '  var btn=document.getElementById(\"player-btn-repeat\");' +\n" +
      "  '  if(!btn)return;' +\n" +
      "  '  var icon=btn.querySelector(\".material-symbols-outlined\");' +\n" +
      "  '  var repeat=localStorage.getItem(\"player-repeat-mode\")||\"off\";' +\n" +
      "  '  if(repeat===\"off\"){' +\n" +
      "  '    btn.style.color=\"var(--outline)\";' +\n" +
      "  '    btn.title=\"Повтор: выкл\";' +\n" +
      "  '    if(icon)icon.textContent=\"repeat\";' +\n" +
      "  '  }else if(repeat===\"all\"){' +\n" +
      "  '    btn.style.color=\"var(--accent-color)\";' +\n" +
      "  '    btn.title=\"Повтор: все\";' +\n" +
      "  '    if(icon)icon.textContent=\"repeat\";' +\n" +
      "  '  }else if(repeat===\"one\"){' +\n" +
      "  '    btn.style.color=\"var(--accent-color)\";' +\n" +
      "  '    btn.title=\"Повтор: один\";' +\n" +
      "  '    if(icon)icon.textContent=\"repeat_one\";' +\n" +
      "  '  }' +\n" +
      "  '}' +\n" +
      "  'function closeSidebarPlayer(){' +\n" +
      "  '  var audio=document.getElementById(\"global-audio\");' +\n" +
      "  '  if(audio)audio.pause();' +\n" +
      "  '  var card=document.getElementById(\"sidebar-player\");' +\n" +
      "  '  if(card)card.style.display=\"none\";' +\n" +
      "  '  activeAudioFp=\"\";activeAudioName=\"\";' +\n" +
      "  '}' +\n" +
      "  'function renderPlaylistModalTracks(){' +\n" +
      "  '  var container=document.getElementById(\"playlist-modal-tracks\");' +\n" +
      "  '  if(!container)return;' +\n" +
      "  '  if(!currentAudioQueue.length){' +\n" +
      "  '    container.innerHTML=\\\'<div style=\"color:var(--outline);text-align:center;padding:24px\">Очередь пуста</div>\\\';' +\n" +
      "  '    return;' +\n" +
      "  '  }' +\n" +
      "  '  var html=\"\";' +\n" +
      "  '  for(var i=0;i<currentAudioQueue.length;i++){' +\n" +
      "  '    var track=currentAudioQueue[i];' +\n" +
      "  '    var isActive=track.fp===activeAudioFp;' +\n" +
      "  '    var bg=isActive?\"color-mix(in srgb,var(--accent-color) 12%,var(--surf-hi))\":\"transparent\";' +\n" +
      "  '    var border=isActive?\"1px solid color-mix(in srgb,var(--accent-color) 30%,transparent)\":\"1px solid transparent\";' +\n" +
      "  '    var textColor=isActive?\"var(--accent-light)\":\"var(--on-surf)\";' +\n" +
      "  '    var icon=isActive?\"volume_up\":\"music_note\";' +\n" +
      "  '    var titleParts=track.name.replace(/\\\\.[^/.]+$/,\"\").split(\" - \");' +\n" +
      "  '    var title=track.name;' +\n" +
      "  '    var artist=\"CloudSpace\";' +\n" +
      "  '    if(titleParts.length>1){' +\n" +
      "  '      var swap=localStorage.getItem(\"player-swap-fields\")===\"true\";' +\n" +
      "  '      if(swap){' +\n" +
      "  '        title=titleParts[0].trim();artist=titleParts.slice(1).join(\" - \").trim();' +\n" +
      "  '      }else{' +\n" +
      "  '        title=titleParts[1].trim();artist=titleParts[0].trim();' +\n" +
      "  '      }' +\n" +
      "  '    }' +\n" +
      "  '    html+=\\\'<div class=\"playlist-track-row\" style=\"display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;background:\\\'+bg+\\\';border:\\\'+border+\\\';cursor:pointer;transition:background 0.2s\" data-fp=\"\\\'+H(track.fp)+\\\'\" data-name=\"\\\'+H(track.name)+\\\'\">\\\';' +\n" +
      "  '    html+=\\\'  <span class=\"material-symbols-outlined\" style=\"font-size:20px;color:\\\'+(isActive?\\'var(--accent-color)\\':\\'var(--outline)\\')+\\\'\">\\\'+icon+\\\'</span>\\\';' +\n" +
      "  '    html+=\\\'  <div style=\"min-width:0;flex:1\" class=\"playlist-track-click\">\\\';' +\n" +
      "  '    html+=\\\'    <div style=\"font-size:13px;font-weight:700;color:\\\'+textColor+\\\';overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">\\\'+H(title)+\\\'</div>\\\';' +\n" +
      "  '    html+=\\\'    <div style=\"font-size:11px;color:var(--outline);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px\">\\\'+H(artist)+\\\'</div>\\\';' +\n" +
      "  '    html+=\\\'  </div>\\\';' +\n" +
      "  '    html+=\\\'  <button class=\"btn-ghost playlist-track-menu\" style=\"width:28px;height:28px;padding:0;min-height:28px;border-radius:50%\" data-fp=\"\\\'+H(track.fp)+\\\'\" data-name=\"\\\'+H(track.name)+\\\'\">\\\';' +\n" +
      "  '    html+=\\\'    <span class=\"material-symbols-outlined\" style=\"font-size:18px\">more_vert</span>\\\';' +\n" +
      "  '    html+=\\\'  </button>\\\';' +\n" +
      "  '    html+=\\\'</div>\\\';' +\n" +
      "  '  }' +\n" +
      "  '  container.innerHTML=html;' +\n" +
      "  '  container.querySelectorAll(\".playlist-track-click\").forEach(function(el){' +\n" +
      "  '    el.addEventListener(\"click\",function(){' +\n" +
      "  '      var parent=el.closest(\".playlist-track-row\");' +\n" +
      "  '      if(parent){' +\n" +
      "  '        playGlobalAudio(parent.dataset.fp,parent.dataset.name,true);' +\n" +
      "  '        renderPlaylistModalTracks();' +\n" +
      "  '      }' +\n" +
      "  '    });' +\n" +
      "  '  });' +\n" +
      "  '  container.querySelectorAll(\".playlist-track-menu\").forEach(function(btn){' +\n" +
      "  '    btn.addEventListener(\"click\",function(e){' +\n" +
      "  '      e.stopPropagation();' +\n" +
      "  '      var rect=btn.getBoundingClientRect();' +\n" +
      "  '      showCtxMenu(rect.left,rect.bottom+window.scrollY,btn.dataset.fp,btn.dataset.name,false);' +\n" +
      "  '    });' +\n" +
      "  '  });' +\n" +
      "  '}' +\n" +
      "  'function initSidebarPlayer(){' +\n" +
      "  '  if(window.sidebarPlayerInitialized)return;' +\n" +
      "  '  var audio=document.getElementById(\"global-audio\");' +\n" +
      "  '  if(!audio)return;' +\n" +
      "  '  var prog=document.getElementById(\"player-progress\");' +\n" +
      "  '  var curTime=document.getElementById(\"player-time-cur\");' +\n" +
      "  '  var durTime=document.getElementById(\"player-time-dur\");' +\n" +
      "  '  audio.addEventListener(\"timeupdate\",function(){' +\n" +
      "  '    if(!audio.duration)return;' +\n" +
      "  '    var pct=(audio.currentTime/audio.duration)*100;' +\n" +
      "  '    prog.value=pct;' +\n" +
      "  '    curTime.textContent=fmtDuration(audio.currentTime);' +\n" +
      "  '  });' +\n" +
      "  '  audio.addEventListener(\"durationchange\",function(){' +\n" +
      "  '    if(!audio.duration)return;' +\n" +
      "  '    durTime.textContent=fmtDuration(audio.duration);' +\n" +
      "  '  });' +\n" +
      "  '  audio.addEventListener(\"ended\",function(){nextGlobalTrack(true);});' +\n" +
      "  '  audio.addEventListener(\"play\",function(){updatePlayButtonState(true);});' +\n" +
      "  '  audio.addEventListener(\"pause\",function(){updatePlayButtonState(false);});' +\n" +
      "  '  prog.addEventListener(\"input\",function(){' +\n" +
      "  '    if(!audio.duration)return;' +\n" +
      "  '    var time=(prog.value/100)*audio.duration;' +\n" +
      "  '    audio.currentTime=time;' +\n" +
      "  '  });' +\n" +
      "  '  document.getElementById(\"player-btn-prev\").addEventListener(\"click\",prevGlobalTrack);' +\n" +
      "  '  document.getElementById(\"player-btn-play\").addEventListener(\"click\",toggleGlobalPlay);' +\n" +
      "  '  document.getElementById(\"player-btn-next\").addEventListener(\"click\",function(){nextGlobalTrack(false);});' +\n" +
      "  '  document.getElementById(\"player-btn-close\").addEventListener(\"click\",closeSidebarPlayer);' +\n" +
      "  '  document.getElementById(\"player-btn-repeat\").addEventListener(\"click\",toggleRepeatMode);' +\n" +
      "  '  document.getElementById(\"player-btn-playlist\").addEventListener(\"click\",function(){' +\n" +
      "  '    document.getElementById(\"modal-playlist\").style.display=\"flex\";' +\n" +
      "  '    renderPlaylistModalTracks();' +\n" +
      "  '  });' +\n" +
      "  '  document.getElementById(\"playlist-modal-close\").addEventListener(\"click\",function(){' +\n" +
      "  '    document.getElementById(\"modal-playlist\").style.display=\"none\";' +\n" +
      "  '  });' +\n" +
      "  '  document.getElementById(\"player-btn-details\").addEventListener(\"click\",function(){' +\n" +
      "  '    if(activeAudioFp&&activeAudioName){' +\n" +
      "  '      openPreview(activeAudioFp,activeAudioName,false);' +\n" +
      "  '    }' +\n" +
      "  '  });' +\n" +
      "  '  var textWrap=document.getElementById(\"player-text-wrap\");' +\n" +
      "  '  if(textWrap){' +\n" +
      "  '    textWrap.addEventListener(\"click\",function(){' +\n" +
      "  '      var swap=localStorage.getItem(\"player-swap-fields\")===\"true\";' +\n" +
      "  '      localStorage.setItem(\"player-swap-fields\",swap?\"false\":\"true\");' +\n" +
      "  '      updatePlayerTrackInfo();' +\n" +
      "  '    });' +\n" +
      "  '  }' +\n" +
      "  '  updateRepeatButtonUI();' +\n" +
      "  '  window.sidebarPlayerInitialized=true;' +\n" +
      "  '}' +\n" +
      "  'function fmtDuration(secs){' +\n" +
      "  '  if(isNaN(secs))return \"0:00\";' +\n" +
      "  '  var m=Math.floor(secs/60);' +\n" +
      "  '  var s=Math.floor(secs%60);' +\n" +
      "  '  return m+\":\"+(s<10?\"0\":\"\")+s;' +\n" +
      "  '}' +";
    lines[i] = replacement;
    console.log("✓ Playback Controller functions successfully inserted!");
    patchedCount++;
  }

  // 7. Initialize player in main IIFE
  if (line.includes('else navigateTo(saved||"");})();')) {
    lines[i] = line.replace('else navigateTo(saved||"");})();', 'else navigateTo(saved||"");})();initSidebarPlayer();');
    console.log("✓ Player initialization successfully added to IIFE!");
    patchedCount++;
  }

  // 8. Intercept Audio clicks in openPreview
  if (line.includes('if(previewKind==="audio"){')) {
    const targetSubstring = 'if(previewKind==="audio"){previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><audio id="preview-plyr" src="${src}" playsinline controls></audio></div>`;setTimeout(function(){try{if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}window.previewPlyrInstance=initPlyr("#preview-plyr",false,"plyr_time_"+src,startTime,autoPlay);}catch(e){console.error(e);}},50);return;}';
    
    if (line.includes(targetSubstring)) {
      const replacementSubstring = "if(previewKind===\"audio\"){previewSrc=src;playGlobalAudio(fp,name,false);body.classList.add(\"media-preview\");body.innerHTML=\\'<div style=\"padding:24px;text-align:center;color:var(--outline)\"><span class=\"material-symbols-outlined\" style=\"font-size:48px;color:var(--accent-color);margin-bottom:10px\">music_note</span><div style=\"font-size:14px;font-weight:700;color:var(--on-surf);margin-bottom:4px\">Воспроизведение...</div><div style=\"font-size:12px;color:var(--outline)\">Трек загружен в плеер сайдбара</div></div>\\';return;}";
      lines[i] = line.replace(targetSubstring, replacementSubstring);
      console.log("✓ Audio click interception successfully added to openPreview!");
      patchedCount++;
    }
  }
}

console.log("Patched sections count:", patchedCount);

// Clean up any empty items if there are any
const outputLines = lines.filter(l => l !== '');

fs.writeFileSync(targetFile, outputLines.join('\n'), 'utf8');
console.log("✓ Overwritten server.js successfully!");
