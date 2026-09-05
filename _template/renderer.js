'use strict';

module.exports.activate = (rhost) => {
  rhost.ui.sidebar.footerButton({
    id: 'open',
    glyph: '★',
    label: 'My Plugin',
    onClick: async () => {
      const r = await rhost.invoke('greet', rhost.sessions.active() || 'nobody');
      rhost.ui.showToast(r.ok ? r.text : `failed: ${r.error}`);
    },
  });
};
