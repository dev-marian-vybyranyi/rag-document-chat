export const TYPESCRIPT = `import { Router } from 'express';
import { hash } from './password.js';

/**
 * Creates the router for sign-in and sign-up.
 */
export function createAuthRouter(deps: Deps) {
  const router = Router();
  router.post('/login', async (req, res) => {
    const user = await deps.users.findByEmail(req.body.email);
    res.json({ user });
  });
  return router;
}

export const MAX_ATTEMPTS = 5;

export const verifyPassword = async (plain: string, stored: string) => {
  return (await hash(plain)) === stored;
};

@Injectable()
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly clock: Clock) {}

  async create(userId: string): Promise<Session> {
    const session = { id: randomId(), userId, createdAt: this.clock.now() };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}

interface Session {
  id: string;
  userId: string;
}
`;

export const PYTHON = `import os
from dataclasses import dataclass


@dataclass
class Settings:
    """Runtime settings read from the environment."""

    database_url: str
    debug: bool = False

    @classmethod
    def from_env(cls):
        return cls(os.environ["DATABASE_URL"], os.environ.get("DEBUG") == "1")


def connect(settings: Settings):
    # Opens a pooled connection.
    return Pool(settings.database_url)


async def fetch_orders(pool, user_id):
    async with pool.acquire() as connection:
        return await connection.fetch("select * from orders where user_id = $1", user_id)
`;

export const GO = `package orders

import "fmt"

type Service struct {
	repo Repository
}

// NewService builds a Service.
func NewService(repo Repository) *Service {
	return &Service{repo: repo}
}

func (s *Service) Total(id string) (int, error) {
	order, err := s.repo.Find(id)
	if err != nil {
		return 0, fmt.Errorf("find %s: %w", id, err)
	}
	return order.Total, nil
}

func (s Service) Name() string {
	return "orders"
}
`;

export const RUST = `use std::collections::HashMap;

pub struct Cache {
    items: HashMap<String, String>,
}

impl Cache {
    pub fn new() -> Self {
        Cache { items: HashMap::new() }
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        self.items.get(key)
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}
`;

export const MARKDOWN = `# Shop API

Orders and payments.

## Install

Run \`npm install\`.

\`\`\`bash
# not a heading
npm start
\`\`\`

## Configure

Set the variables below.
`;

export function bigFunction(statements: number): string {
  const body = Array.from(
    { length: statements },
    (_, i) => `  total += compute${i}(input.items[${i}], options);`,
  ).join('\n');
  return `export function aggregate(input: Input, options: Options) {\n  let total = 0;\n${body}\n  return total;\n}\n`;
}

export function bigClass(methods: number): string {
  const members = Array.from(
    { length: methods },
    (_, i) =>
      `  method${i}(value: number): number {\n    const doubled = value * ${i + 2};\n    return doubled + ${i};\n  }\n`,
  ).join('\n');
  return `export class Calculator {\n  private base = 1;\n\n${members}}\n`;
}
