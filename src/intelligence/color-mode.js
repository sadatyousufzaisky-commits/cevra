const systemLight = matchMedia('(prefers-color-scheme: light)');
const applyColorMode = () => { document.documentElement.dataset.colorMode = systemLight.matches ? 'light' : 'dark'; };
applyColorMode();
systemLight.addEventListener('change', applyColorMode);
