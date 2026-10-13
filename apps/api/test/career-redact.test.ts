import { describe, expect, it } from 'vitest';
import { redactResume } from '../src/career/redact.js';

const text = (input: string) => redactResume(input).text;

describe('redacting a resume', () => {
  describe('email addresses', () => {
    it.each([
      ['a plain address', 'Write to alex.morgan@example.com today', 'Write to [email] today'],
      ['a tagged address', 'alex+jobs@mail.example.co.uk', '[email]'],
      ['an address in capitals', 'ALEX@EXAMPLE.COM', '[email]'],
      ['several addresses', 'a@x.io, b@y.io', '[email], [email]'],
    ])('replaces %s', (_label, input, expected) => {
      expect(text(input)).toBe(expected);
    });

    it('keeps an at sign that is not an address', () => {
      expect(text('Follow @alexm for updates, meet @ 5pm')).toBe(
        'Follow @alexm for updates, meet @ 5pm',
      );
    });
  });

  describe('links', () => {
    it.each([
      ['a full address', 'See https://example.com/portfolio?id=7 now', 'See [link] now'],
      ['a www address', 'Site: www.alex.dev/blog', 'Site: [link]'],
      ['a profile without a scheme', 'linkedin.com/in/alex-morgan', '[link]'],
      ['a profile with a sub-domain', 'uk.linkedin.com/in/alex', '[link]'],
      ['a repository', 'github.com/alex/repo', '[link]'],
    ])('replaces %s', (_label, input, expected) => {
      expect(text(input)).toBe(expected);
    });

    it('keeps the punctuation that ends the sentence', () => {
      expect(text('Code: https://github.com/alex/repo.')).toBe('Code: [link].');
      expect(text('(see https://example.com/a)')).toBe('(see [link])');
    });

    it('keeps technology names that look like domains', () => {
      const input = 'Built with Node.js, Vue.js, ASP.NET and Next.js on example.';

      expect(text(input)).toBe(input);
    });

    it('does not read a number out of a link as a phone number', () => {
      expect(redactResume('linkedin.com/in/alex-415-555-0134').removed).toMatchObject({
        links: 1,
        phones: 0,
      });
    });
  });

  describe('phone numbers', () => {
    it.each([
      ['an international number', '+380 44 123 45 67'],
      ['a number with a country code and brackets', '+1 (415) 555-0134'],
      ['a number with brackets', '(415) 555-0134'],
      ['a number with dashes', '415-555-0134'],
      ['a number with dots', '415.555.0134'],
      ['a US number with spaces', '415 555 0134'],
      ['a UK number with spaces', '0770 090 0123'],
      ['a number in pairs', '06 12 34 56 78'],
      ['a long local number with dashes', '044-123-45-67'],
    ])('replaces %s', (_label, number) => {
      expect(text(`Phone: ${number}, available`)).toBe('Phone: [phone], available');
    });

    it.each([
      ['a range of years', 'Acme, 2019-2021'],
      ['a range of months', 'Senior Engineer, Acme (2021-03 - 2024-06)'],
      ['a range of months with slashes', 'Acme 03/2021 - 06/2024'],
      ['a range of years with dots', 'Acme 2021.03 - 2024.06'],
      ['a date', 'Joined on 2020-01-15 and left on 15.03.2023'],
      ['a version number', 'Upgraded Node 18.19.1 and Windows 10.0.19041.1'],
      ['an address of a machine', 'Hosted on 192.168.100.200'],
      ['a count written with spaces', 'Served 120 000 000 requests a month'],
      ['a number with commas', 'Raised 1,200,000 in funding'],
      ['a percentage', 'Cut costs by +35% and latency by 120 ms'],
      ['a short number', 'Call 555-0134 or ext 4412'],
      ['a number with too few digits', 'Order 12-34-56-78 shipped'],
      ['a number with too many digits', 'Card 1234-5678-9012-3456-7890'],
    ])('keeps %s', (_label, input) => {
      expect(text(input)).toBe(input);
    });
  });

  describe('street addresses', () => {
    it('replaces a street address in a sentence', () => {
      expect(text('Lives at 221 Baker Street, Apt 4B. Open to relocation.')).toBe(
        'Lives at [address]. Open to relocation.',
      );
    });

    it('removes a line that starts with the word address', () => {
      expect(text('Alex\nAddress: 12 Rose Lane, Springfield\nEngineer')).toBe('Alex\nEngineer');
      expect(text('Home Address - Somewhere 5')).toBe('');
    });

    it('keeps a sentence about an address of a service', () => {
      const input = 'Built the address lookup service for 3 million users';

      expect(text(input)).toBe(input);
    });
  });

  describe('personal attributes', () => {
    it.each([
      'Date of birth: 1990-04-02',
      'DOB: 02/04/1990',
      'D.O.B. - 2 April 1990',
      'Birthday: April 2',
      'Born: 1990',
      'Born 12 May 1990',
      'Date of birth 1990-04-02',
      'Place of birth: Kyiv',
      'Age: 34',
      'Gender: female',
      'Sex - M',
      'Marital status: single',
      'Family status: married, two children',
      'Nationality: Ukrainian',
      'Religion: none',
      'Photo: attached',
      '  - Date of birth: 1990-04-02',
    ])('removes the line "%s"', (line) => {
      expect(text(`Alex Morgan\n${line}\nBackend engineer`)).toBe('Alex Morgan\nBackend engineer');
    });

    it('removes only the attribute from a line of details', () => {
      expect(text('Kyiv | Born: 1990 | alex@example.com')).toBe('Kyiv | [email]');
      expect(text('Nationality: Ukrainian • Gender: male')).toBe('');
    });

    it.each([
      'Born in Kyiv, I moved to Berlin at twenty.',
      'Age of Empires fan and open source maintainer',
      'Designed a photo upload service',
      'Gender-neutral language checker for documentation',
      'Sex education platform: built the quiz engine',
      'Citizenship: EU, no visa needed',
    ])('keeps the line "%s"', (line) => {
      expect(text(line)).toBe(line);
    });
  });

  describe('as a whole', () => {
    const resume = [
      'Alex Morgan',
      'alex.morgan@example.com | +1 (415) 555-0134 | linkedin.com/in/alexmorgan',
      'Date of birth: 1990-04-02',
      'Marital status: single',
      '',
      'EXPERIENCE',
      'Senior Engineer, Acme (2021-03 - 2024-06)',
      '- Cut p95 latency from 800 ms to 120 ms across 3 services',
      '- Upgraded Node 18.19.1 to 20.11.0',
    ].join('\n');

    it('removes contact details and keeps the work history word for word', () => {
      expect(text(resume)).toBe(
        [
          'Alex Morgan',
          '[email] | [phone] | [link]',
          '',
          'EXPERIENCE',
          'Senior Engineer, Acme (2021-03 - 2024-06)',
          '- Cut p95 latency from 800 ms to 120 ms across 3 services',
          '- Upgraded Node 18.19.1 to 20.11.0',
        ].join('\n'),
      );
    });

    it('counts what it removed, without keeping the values', () => {
      const { removed } = redactResume(resume);

      expect(removed).toEqual({
        emails: 1,
        links: 1,
        phones: 1,
        addresses: 0,
        attributeLines: 2,
      });
    });

    it('changes nothing when there is nothing to remove', () => {
      const input = 'Senior Engineer\n- Built things with TypeScript';

      expect(redactResume(input)).toEqual({
        text: input,
        removed: { emails: 0, links: 0, phones: 0, addresses: 0, attributeLines: 0 },
      });
    });

    it('gives the same result when it is applied twice', () => {
      const messy = [
        resume,
        'Address: 1 Main Street',
        'Call 415-555-0134 or write to a@b.io, see https://x.dev/a.',
        'Lives at 221 Baker Street, Apt 4B.',
      ].join('\n');

      const once = redactResume(messy);
      const twice = redactResume(once.text);

      expect(twice.text).toBe(once.text);
      expect(twice.removed).toEqual({
        emails: 0,
        links: 0,
        phones: 0,
        addresses: 0,
        attributeLines: 0,
      });
    });

    it('handles an empty text and very long lines', () => {
      expect(redactResume('').text).toBe('');
      const long = `${'word '.repeat(20_000)}a@b.io`;

      expect(redactResume(long).text.endsWith('[email]')).toBe(true);
    });
  });
});
