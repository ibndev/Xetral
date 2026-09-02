import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { Req } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { CountriesService } from './countries.service.js';
import type { Country } from './countries.service.js';

/**
 * The countries a customer may sign up from.
 *
 * PUBLIC, because the signup form needs it BEFORE anybody has an account —
 * the same reason the terms are public. It carries no customer data: a list
 * of countries, their dialling codes and the currency each leads with, which
 * is what a customer would see on the form anyway.
 */
@Controller('v1/countries')
export class CountriesController {
  constructor(@Inject(CountriesService) private readonly countries: CountriesService) {}

  @Get()
  async list(): Promise<{ countries: readonly Country[] }> {
    return { countries: await this.countries.open() };
  }
}

const addSchema = z.object({
  // Uppercased here rather than refused, because an operator typing "ng" has
  // not made a mistake worth an error message.
  code: z.string().trim().toUpperCase().length(2).regex(/^[A-Z]{2}$/),
  name: z.string().trim().min(2).max(80),
  dial_code: z.string().trim().regex(/^[0-9]{1,4}$/),
  currency: z.string().trim().toUpperCase().min(3).max(5),
});

const enabledSchema = z.object({ enabled: z.boolean() });

/**
 * Adding a country without a deploy.
 *
 * A SEPARATE CONTROLLER under `/v1/admin`, because `route-coverage.test.ts`
 * fails the build if an admin route is declared with anything but `staff()` —
 * and mixing the public read into the same controller would put a customer
 * route behind a staff prefix or the reverse.
 */
@Controller('v1/admin/countries')
export class AdminCountriesController {
  constructor(@Inject(CountriesService) private readonly countries: CountriesService) {}

  @Get()
  async list(): Promise<{
    countries: readonly Country[];
    /** What a country may name, from the money registry. The form offers
     *  these and nothing else — see the service for why. */
    currencies: readonly { code: string; name: string }[];
  }> {
    return {
      countries: await this.countries.all(),
      currencies: this.countries.supportedCurrencies(),
    };
  }

  @Post()
  async add(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Country> {
    const parsed = addSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_request' });

    // ADDED CLOSED, always. Opening it is a second, deliberate act — see the
    // migration header: an INSERT into a reference table should not be a
    // licensing decision.
    return this.countries.add({
      code: parsed.data.code,
      name: parsed.data.name,
      dialCode: parsed.data.dial_code,
      currency: parsed.data.currency,
      actorId: claimsOf(request).sub,
    });
  }

  @Post(':code')
  async setEnabled(@Param('code') code: string, @Body() body: unknown): Promise<Country> {
    const parsed = enabledSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_request' });
    return this.countries.setEnabled(code.toUpperCase(), parsed.data.enabled);
  }
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('country route reached without verified claims');
  return claims;
}
