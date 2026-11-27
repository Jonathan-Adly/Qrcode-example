'use strict';

const express = require('express');

const CODE_PATTERN = /^[a-z0-9]{4,32}$/;

module.exports = function publicRoutes({ store }) {
  const router = express.Router();

  // The page customers land on after scanning a QR code.
  router.get('/m/:code', (req, res) => {
    const menu = CODE_PATTERN.test(req.params.code) ? store.getMenuByCode(req.params.code) : null;
    const isPreview = Boolean(menu && !menu.published && res.locals.isAdmin);

    if (!menu || (!menu.published && !isPreview)) {
      return res.status(404).render('error', {
        title: 'Menu not available',
        message: "This menu isn't available right now. Please ask a member of staff.",
      });
    }

    // Always revalidate so edits show up as soon as the admin saves.
    res.set('Cache-Control', 'no-cache');
    res.render('menu', { menu, isPreview });
  });

  return router;
};
