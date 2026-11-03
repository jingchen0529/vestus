(() => {
  'use strict';
  const route = __VESTUS_LOGIN_ROUTE__;
  if (window.top !== window || location.origin !== route.origin) return;
  const installed = '__vestusManagedLoginGuard';
  if (Object.prototype.hasOwnProperty.call(window, installed)) return;
  Object.defineProperty(window, installed, { value: true });

  const isLogin = () => {
    const url = new URL(location.href);
    return !url.username && !url.password && url.origin === route.origin
      && (url.pathname === route.path || url.pathname.startsWith(`${route.path}/`));
  };
  let lockedRoot = null;
  let previous = null;
  const properties = ['opacity', 'pointer-events'];
  const release = () => {
    if (!lockedRoot) return;
    for (const [index, name] of properties.entries()) {
      const [value, priority] = previous.styles[index];
      if (value) lockedRoot.style.setProperty(name, value, priority);
      else lockedRoot.style.removeProperty(name);
    }
    lockedRoot.inert = previous.inert;
    lockedRoot = null;
    previous = null;
  };
  const sync = () => {
    if (!isLogin()) {
      release();
      return;
    }
    const root = document.documentElement;
    if (!root) return;
    if (lockedRoot !== root) {
      release();
      lockedRoot = root;
      previous = {
        inert: root.inert,
        styles: properties.map(name => [root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]),
      };
    }
    // Hide the complete subtree, including QR codes and cross-origin login frames.
    for (const [name, value] of [['opacity', '0'], ['pointer-events', 'none']]) {
      if (root.style.getPropertyValue(name) !== value || root.style.getPropertyPriority(name) !== 'important') {
        root.style.setProperty(name, value, 'important');
      }
    }
    if (!root.inert) root.inert = true;
  };
  const block = event => {
    if (!isLogin()) return;
    sync();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const name of [
    'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'change',
    'paste', 'cut', 'copy', 'drop', 'dragstart', 'compositionstart', 'compositionupdate', 'compositionend',
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick',
    'touchstart', 'touchend', 'contextmenu', 'focus', 'focusin', 'submit',
  ]) {
    window.addEventListener(name, block, { capture: true, passive: false });
  }
  for (const name of ['submit', 'requestSubmit']) {
    const original = HTMLFormElement.prototype[name];
    if (typeof original !== 'function') continue;
    HTMLFormElement.prototype[name] = function (...args) {
      if (isLogin()) return;
      return Reflect.apply(original, this, args);
    };
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      sync();
      return result;
    };
  }
  for (const name of ['popstate', 'hashchange', 'pageshow']) {
    window.addEventListener(name, sync, true);
  }
  new MutationObserver(sync).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'inert'],
  });
  sync();
})();
