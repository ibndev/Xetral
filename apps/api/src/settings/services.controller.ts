import { Controller, Get, Inject } from '@nestjs/common';
import { KILL_SWITCHES, SettingsService } from './settings.service.js';
import type { KillSwitch } from './settings.service.js';

/**
 * WHICH SERVICES ARE SWITCHED ON, for the apps to draw themselves from.
 *
 * The kill switches refused at the endpoint and nowhere else, so a customer
 * saw the Cards tile, tapped it, filled in a form and was told at the last
 * step that cards are paused. With the switch visible up front, a paused
 * service reads "Coming soon" where it is offered, before anybody starts.
 *
 * THE REFUSAL IS STILL THE CONTROL. This read is a courtesy that can be
 * stale by five seconds of cache or a screen left open; every flow still
 * asserts its switch on the request that moves money.
 *
 * Read from `KILL_SWITCHES` itself rather than a second list here, so a
 * switch added there is reported here without anybody remembering to.
 */
@Controller('v1')
export class ServicesController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get('services')
  async services(): Promise<{ readonly services: Readonly<Record<KillSwitch, boolean>> }> {
    const names = Object.keys(KILL_SWITCHES) as KillSwitch[];
    const states = await Promise.all(names.map((name) => KILL_SWITCHES[name](this.settings)));
    return {
      services: Object.fromEntries(names.map((name, i) => [name, states[i] === true])) as Record<
        KillSwitch,
        boolean
      >,
    };
  }
}
