'use strict';

// Adds a sample menu so you can try the app straight away: `npm run seed`

const path = require('node:path');
const { openDatabase } = require('../src/db');
const { validateMenu } = require('../src/validate');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const store = openDatabase(path.join(dataDir, 'menus.db'));

const sample = validateMenu({
  title: 'The Corner Café',
  description: 'All-day menu · Served 8am – 4pm\nPlease tell us about any allergies when you order.',
  currency: '$',
  published: true,
  sections: [
    {
      name: 'Breakfast',
      description: 'Served until 11:30am',
      items: [
        { name: 'Avocado toast', price: '11', description: 'Sourdough, smashed avocado, chili flakes, lemon', tags: 'Vegan' },
        { name: 'Eggs Benedict', price: '14.5', description: 'Poached eggs, ham, hollandaise, English muffin' },
        { name: 'Buttermilk pancakes', price: '12', description: 'Maple syrup, berries, whipped butter', tags: 'Vegetarian' },
      ],
    },
    {
      name: 'Lunch',
      items: [
        { name: 'Grilled chicken sandwich', price: '15', description: 'Pesto, roasted peppers, rocket, ciabatta' },
        { name: 'Harvest salad', price: '13', description: 'Quinoa, roasted squash, feta, pumpkin seeds', tags: 'Vegetarian, Gluten-free' },
        { name: 'Soup of the day', price: 'Ask your server', description: 'Served with warm bread' },
        { name: 'Fish tacos', price: '16', description: 'Beer-battered cod, slaw, lime crema', tags: 'Spicy', available: false },
      ],
    },
    {
      name: 'Drinks',
      items: [
        { name: 'Espresso', price: '3' },
        { name: 'Flat white', price: '4.5' },
        { name: 'Fresh orange juice', price: '5' },
        { name: 'Iced tea', price: '4', tags: 'House-made' },
      ],
    },
  ],
});

const menu = store.createMenu(sample);
store.close();

console.log(`Created sample menu "${menu.title}".`);
console.log(`  Customer page: /m/${menu.code}`);
console.log(`  Edit it at:    /admin/menus/${menu.id}`);
