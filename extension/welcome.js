document.getElementById('open-popup-hint').addEventListener('click', () => {
  alert('Чтобы закрепить иконку расширения:\n\n1. Кликните на значок 🧩 (пазл) справа от адресной строки\n2. Найдите в списке «Sipliy Folder VPS»\n3. Нажмите на 📌 (булавку) рядом с ним\n\nГотово — иконка теперь всегда на виду!');
});

const footer = document.getElementById('ext-version');
if (footer) footer.textContent = chrome.runtime.getManifest().version;
