let chosen = null;
const share = document.getElementById('share');
window.fabricPicker.sources().then((list) => {
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'src';
    b.type = 'button';
    const img = document.createElement('img');
    img.src = s.thumbnail;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = s.name;
    b.append(img, name);
    b.addEventListener('click', () => {
      document.querySelectorAll('.src.on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      chosen = s.id;
      share.disabled = false;
    });
    b.addEventListener('dblclick', () => window.fabricPicker.choose(s.id));
    document.getElementById(s.id.startsWith('screen:') ? 'screens' : 'windows').append(b);
  }
});
share.addEventListener('click', () => chosen && window.fabricPicker.choose(chosen));
document.getElementById('cancel').addEventListener('click', () => window.fabricPicker.choose(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.fabricPicker.choose(null); });
