import { describe, expect, it } from 'vitest';
import { describeJob, detectJobs, type JobFacts } from '../src/career/question-jobs.js';

const job = (jobNumber: number, overrides: Partial<JobFacts> = {}): JobFacts => ({
  id: `job-${jobNumber}`,
  jobNumber,
  name: `Posting ${jobNumber}`,
  title: null,
  company: null,
  ...overrides,
});

const jobs: JobFacts[] = [
  job(1, { name: 'Data Engineer', title: 'Senior Data Engineer', company: 'Globex' }),
  job(2, { name: 'Platform Engineer', title: 'Platform Engineer', company: 'Acme' }),
  job(3, { name: 'Designer', title: 'Product Designer', company: null }),
];

const numbersIn = (question: string, facts: JobFacts[] = jobs) =>
  detectJobs(question, facts).map((found) => found.jobNumber);

describe('detectJobs: by number', () => {
  it.each([
    ['How does my experience align with Job #2?', [2]],
    ['how does my experience align with job #2', [2]],
    ['How do I fit job 2?', [2]],
    ['What am I missing for Job#3?', [3]],
    ['Job number 1: what do I lack?', [1]],
    ['What about job no. 2?', [2]],
    ['Compare posting #1 with posting #3', [1, 3]],
    ['Compare jobs 1 and 3', [1, 3]],
    ['Compare Jobs #1, #2 and #3', [1, 2, 3]],
    ['Is vacancy 2 realistic?', [2]],
    ['Tell me about role #2', [2]],
    ['Position #3 requirements?', [3]],
  ])('finds the postings in %j', (question, expected) => {
    expect(numbersIn(question)).toEqual(expected);
  });

  it.each([
    ['the first job', [1]],
    ['How do I fit the second posting?', [2]],
    ['Which skills am I missing for the third role?', [3]],
    ['Is the SECOND position a stretch?', [2]],
  ])('finds the posting in the ordinal %j', (question, expected) => {
    expect(numbersIn(question)).toEqual(expected);
  });

  it('ignores a number that is a length of time, a count or a percentage', () => {
    expect(numbersIn('In my last job 2 years ago I used Kubernetes')).toEqual([]);
    expect(numbersIn('A job 3 months long, and a role 2 yrs')).toEqual([]);
    expect(numbersIn('Job 1 years')).toEqual([]);
    expect(numbersIn('job 2025')).toEqual([]);
    expect(numbersIn('job 40% done')).toEqual([]);
  });

  it('reads numbers of two and three digits whole', () => {
    const many = [job(2), job(12), job(202), job(10)];

    expect(numbersIn('Compare jobs 2 and 12', many)).toEqual([2, 12]);
    expect(numbersIn('Job #202?', many)).toEqual([202]);
    expect(numbersIn('job 2025', many)).toEqual([]);
    expect(numbersIn('job 1000', many)).toEqual([]);
  });

  it('ignores a number without a posting word, and a posting word without a number', () => {
    expect(numbersIn('I have 2 years of experience')).toEqual([]);
    expect(numbersIn('What does the job need?')).toEqual([]);
    expect(numbersIn('Which role 2 would suit me?')).toEqual([]);
  });

  it('ignores a number nobody has', () => {
    expect(numbersIn('How do I fit Job #7?')).toEqual([]);
    expect(numbersIn('the tenth job')).toEqual([]);
  });

  it('lists the postings in the order of their numbers, whatever the order they were given in', () => {
    expect(numbersIn('Compare jobs 3, 1 and 2', [jobs[2]!, jobs[0]!, jobs[1]!])).toEqual([1, 2, 3]);
  });

  it('finds nothing without postings', () => {
    expect(detectJobs('Job #2?', [])).toEqual([]);
  });
});

describe('detectJobs: by name', () => {
  it('finds a posting by its company, by its title and by the name it was given', () => {
    expect(numbersIn('What does Acme want?')).toEqual([2]);
    expect(numbersIn('Do I fit the Senior Data Engineer role?')).toEqual([1]);
    expect(numbersIn('How do I fit the Product Designer opening?')).toEqual([3]);
    expect(numbersIn('what about the data engineer posting')).toEqual([1]);
  });

  it('does not match part of another word', () => {
    expect(numbersIn('What about Acmeville?')).toEqual([]);
    expect(numbersIn('What about Globexx?')).toEqual([]);
  });

  it('takes a one-word name only when it is written with a capital letter', () => {
    expect(numbersIn('Do I know what acme wants?')).toEqual([]);
    expect(numbersIn('Do I know what Acme wants?')).toEqual([2]);
    const common = [job(1, { company: 'Apple' })];
    expect(numbersIn('Do I eat an apple a day?', common)).toEqual([]);
    expect(numbersIn('Do I fit Apple?', common)).toEqual([1]);
  });

  it('takes a name of several words in any case', () => {
    expect(numbersIn('do i fit product designer')).toEqual([3]);
  });

  it('finds every posting that shares the name', () => {
    const shared = [
      job(1, { company: 'Acme' }),
      job(2, { company: 'Globex' }),
      job(3, { company: 'Acme' }),
    ];

    expect(numbersIn('What does Acme want?', shared)).toEqual([1, 3]);
  });

  it('combines a number and a name, once for each posting', () => {
    expect(numbersIn('Compare Job #1 with Acme')).toEqual([1, 2]);
    expect(numbersIn('Job #2 at Acme')).toEqual([2]);
  });

  it('ignores names that are empty or too short to mean anything', () => {
    const odd = [job(1, { company: '', title: 'QA', name: 'a' })];

    expect(numbersIn('QA a ?', odd)).toEqual([]);
  });

  it('is not led astray by characters that mean something in a pattern', () => {
    const odd = [job(1, { company: 'C++ (Labs)', title: null })];

    expect(numbersIn('Do I fit C++ (Labs)?', odd)).toEqual([1]);
    expect(numbersIn('Do I fit C?', odd)).toEqual([]);
  });

  it('works with names in other alphabets', () => {
    const local = [job(1, { company: 'Київстар' })];

    expect(numbersIn('Чи підходжу я Київстар?', local)).toEqual([1]);
    expect(numbersIn('київстар', local)).toEqual([]);
  });
});

describe('describeJob', () => {
  it('names the posting by its number and its name', () => {
    expect(describeJob(jobs[1]!)).toBe('Job #2 · Platform Engineer');
  });

  it('cleans a name that came from a file', () => {
    expect(describeJob(job(4, { name: '  Back​end\n  Dev  ' }))).toBe('Job #4 · Backend Dev');
    expect(describeJob(job(5, { name: 'x'.repeat(300) })).length).toBeLessThanOrEqual(130);
  });
});
