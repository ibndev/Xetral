import { describe, expect, it } from 'vitest';
import { personNameProblem } from './person-name.js';

describe('a person name', () => {
  it.each([
    'Other Things',
    "Let's Create",
    'lets create',
    'Test User',
    'John Doe',
    'jane doe',
    'Ada 123',
    'Ada 😀',
    'aaaa bbbb',
    'Hello World',
    'A B',
    'xetral customer',
    'Ada @Obi',
  ])('refuses %j', (name) => {
    expect(personNameProblem(name)).toBe('not_a_name');
  });

  it.each([
    'Olawale Adeyemi',
    'Blessing Okafor',
    'Favour Precious Eze',
    'Goodluck Jonathan',
    'Patience Mercy Obi',
    'Sunday Adewale',
    "Chinua O'Neil",
    'Ama Serwaa-Mensah',
    'Kwame Nkrumah',
    'Wanjiru Kamau',
    'Adaeze Okonkwo',
    'Émile Zola',
    'St. John Smith',
  ])('accepts %j', (name) => {
    expect(personNameProblem(name)).toBeUndefined();
  });
});
