CREATE TYPE user_role AS ENUM ('admin', 'member');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  role user_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES users,
  title text NOT NULL,
  body text,
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz
);
