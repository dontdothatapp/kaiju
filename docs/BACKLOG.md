# Backlog: kaiju ideas and things to fix

Gameplay, feel and presentation items for MEGATON. Performance work lives in
[OPTIMIZATION_BACKLOG.md](OPTIMIZATION_BACKLOG.md) (measured on Bloodline, the superhero game this
was forked from; the engine is the same). Test with `?mute` so the music doesn't play while
iterating, and `tools/s_kaiju.mjs` to run every move once.

## 1. The robot combines on the way in

**Now.** KAISER-OH drops out of the sky with its thrusters lit, like GORRAX does.
**Want.** The sentai finale: three or four vehicles (a jet, a tank, a drill car) race in, leap,
and lock together into the robot mid-air, with a pose and a flash at the end.
**Way in.** `src/game/intro.js` already scripts shots and events per round; the rig in
`src/game/character.js` is built from groups that could fly in separately (legs, torso, arms,
helmet) and snap onto their joints before `_drop` hands over to the landing.

## 2. Pick things up and use them

**Want.** Kaiju grab what's lying around: a parked car to throw, a train car to swing (Godzilla
bit the elevated train in 1954), the broken top of a tower as a club.
**Way in.** Props and train cars are Rapier bodies (`src/world/props.js`, `train.js`); a grab
with no opponent in reach could look for the nearest one in front, make it kinematic in the hand
(`model.handWorld`) and launch it like `Fighter.launch` on throw.

## 3. The military shows up (done, mostly)

**Now.** Attack helicopters hover round the monster and tanks patrol the avenues, firing at it;
anything a kaiju does takes them out (`src/world/military.js`, README "The military").
**Still wanted.** Jets making passes overhead. Wrecks as Rapier bodies, so a downed helicopter
tumbles down a facade and a tank can be kicked down the street (or picked up, see 2). Shells
that stop at the first building in the way and take a bite out of it.

## 4. Sounds recorded for the scale

**Now.** GORRAX's voice is Bloodline's villain voice at ~0.6× speed, and footfalls, roars and
beams are synthesized in `AudioEngine`.
**Want.** Proper recordings (or ElevenLabs effects via `tools/elevenlabs-sfx.mjs`): a long
roar with a tail, heavy servo whines for the robot's joints, a beam charge and pour, distant
sirens after the first collapse.

## 5. Tail grab and the giant swing

**Want.** Grabbing GORRAX from behind catches the tail; the robot swings him round in a full
circle (everything in the radius gets swept) and lets go into the skyline.
**Way in.** `Fighter._startGrab` can check where the grabber stands relative to the victim's yaw;
the swing is the tail whip's `spinYaw` applied to the grabber with the victim held at
`R + tail length`.

## 6. Local two-player

Both fighters already read a `Controller`; a second keyboard half or pad mapped to the bot's
controller and a camera that frames both (the recap's `orbit` shot is close) would do it.
