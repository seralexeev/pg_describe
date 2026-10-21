import pg from 'pg';

import { createPost, createUser, findUserByEmail, listPosts } from './users.sql';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres',
});

const user = await createUser(pool, { email: `ada+${Date.now()}@example.com`, name: 'Ada', role: 'admin' });
await createPost(pool, { authorId: user.id, title: 'Hello', tags: ['intro'], meta: { draft: false } });

const found = await findUserByEmail(pool, { email: user.email });
const posts = await listPosts(pool, { authorId: user.id });

console.log(found?.role, posts.map((p) => `${p.title} by ${p.authorEmail}`));
await pool.end();
