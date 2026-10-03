import { Game } from './core/Game.js';

const game = new Game(document.getElementById('app'), document.getElementById('ui'));
game.init().catch((err) => {
  console.error(err);
  const msg = document.querySelector('#loading .msg');
  if (msg) msg.textContent = `초기화 실패: ${err.message}`;
});
