import { Controller, Get, Inject } from '@nestjs/common';
import { KILL_SWITCHES, SettingsService } from './settings.service.js';
import type { KillSwitch, ServiceState } from './settings.service.js';

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
 *
 * `services` STAYS A BOOLEAN PER SERVICE, and `states` carries the three
 * (093). An app already installed reads `services` and nothing else, so for
 * it a hidden service is an off one and reads "Coming soon" — the safe
 * direction, and its endpoints refuse either way. A build that knows about
 * `states` hides it.
 */
@Controller('v1')
export class ServicesController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get('services')
  async services(): Promise<{
    readonly services: Readonly<Record<KillSwitch, boolean>>;
    readonly states: Readonly<Record<KillSwitch, ServiceState>>;
  }> {
    const states = await this.settings.serviceStates();
    const names = Object.keys(KILL_SWITCHES) as KillSwitch[];
    return {
      services: Object.fromEntries(names.map((name) => [name, states[name] === 'enabled'])) as Record<
        KillSwitch,
        boolean
      >,
      states,
    };
  }
}
