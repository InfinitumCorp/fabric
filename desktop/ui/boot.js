// Boot overlay: shows the mark while the relay page loads, or a retry button when it can't load.
window.fabricBoot?.onState((state) => document.body.classList.toggle('down', state === 'offline'));
document.getElementById('retry').addEventListener('click', () => window.fabricBoot?.retry());
