/* 主题在首屏渲染前应用，避免闪一下白/黑 */
(function () {
  'use strict';
  var THEMES = ['night', 'day'];
  var BGS = ['aurora', 'deep', 'sakura', 'plain'];
  var root = document.documentElement;

  function valid(list, value) {
    return value && list.indexOf(value) >= 0 ? value : null;
  }

  function stored(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* 无痕模式忽略 */
    }
  }

  var params = new URLSearchParams(window.location.search);
  var theme = valid(THEMES, params.get('theme')) || valid(THEMES, stored('lizi.theme')) || 'night';
  var bg = valid(BGS, params.get('bg')) || valid(BGS, stored('lizi.bg')) || 'aurora';

  if (params.get('theme')) save('lizi.theme', theme);
  if (params.get('bg')) save('lizi.bg', bg);

  root.setAttribute('data-theme', theme);
  root.setAttribute('data-bg', bg);

  window.LiziTheme = {
    themes: THEMES,
    backgrounds: BGS,
    get: function () {
      return { theme: root.getAttribute('data-theme'), bg: root.getAttribute('data-bg') };
    },
    set: function (next) {
      var t = valid(THEMES, next && next.theme);
      var b = valid(BGS, next && next.bg);
      if (t) {
        root.setAttribute('data-theme', t);
        save('lizi.theme', t);
      }
      if (b) {
        root.setAttribute('data-bg', b);
        save('lizi.bg', b);
      }
      window.dispatchEvent(new CustomEvent('themechange', { detail: window.LiziTheme.get() }));
    },
  };
})();
