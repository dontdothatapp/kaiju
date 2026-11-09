// Time control: hitstop (freeze frames), slow motion and their recovery curves.
// Every gameplay system consumes `dt` (game time); camera shake and post FX use `realDt`
// so the screen keeps shaking while the world is frozen - the classic hitstop read.
import { clamp } from './math.js';

export class TimeControl {
  constructor() {
    this.realTime = 0;
    this.gameTime = 0;
    this.dt = 0;
    this.realDt = 0;
    this.hitstop = 0;       // seconds of real time left frozen
    this.scale = 1;         // current time scale
    this.slowTarget = 1;
    this.slowTimer = 0;     // real seconds the slow-mo holds before easing back
    this.slowRecover = 2.5; // ease-back speed
    this.pace = 1;          // the player's game-speed setting (title options / ?pace=); hitstop and slow-mo stay real-time
    this.paused = false;
  }

  // Freeze the world. Stronger hits = longer freezes; never shortens an active freeze.
  freeze(seconds) {
    this.hitstop = Math.max(this.hitstop, seconds);
  }

  // Drop into slow motion for `hold` real seconds, then ease back to 1.
  slowmo(scale, hold, recover = 2.5) {
    if (scale <= this.slowTarget || this.slowTimer <= 0) {
      this.slowTarget = scale;
      this.scale = Math.min(this.scale, scale);
    }
    this.slowTimer = Math.max(this.slowTimer, hold);
    this.slowRecover = recover;
  }

  update(realDt) {
    this.realDt = realDt;
    this.realTime += realDt;
    if (this.paused) { this.dt = 0; return; }

    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      this.dt = 0;
      return;
    }
    if (this.slowTimer > 0) {
      this.slowTimer -= realDt;
      this.scale += (this.slowTarget - this.scale) * clamp(realDt * 20, 0, 1);
    } else {
      this.slowTarget = 1;
      this.scale += (1 - this.scale) * clamp(realDt * this.slowRecover, 0, 1);
      if (this.scale > 0.995) this.scale = 1;
    }
    this.dt = realDt * this.scale * this.pace;
    this.gameTime += this.dt;
  }

  get frozen() { return this.hitstop > 0; }
}
