CREATE TYPE kind AS ENUM ('shop', 'pos');

CREATE TABLE items (
  id int PRIMARY KEY,
  title text NOT NULL,
  kind kind NOT NULL,
  note text,
  payload jsonb
);
