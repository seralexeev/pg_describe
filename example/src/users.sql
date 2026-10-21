/* @name createUser */
INSERT INTO users (email, name, role)
VALUES (:email, :name, :role)
RETURNING id, email, name, role, created_at;

/* @name findUserByEmail */
SELECT id, email, name, role
FROM users
WHERE email = :email;

/* @name listPosts */
SELECT p.id, p.title, p.tags, u.email AS author_email, p.meta
FROM posts p
JOIN users u ON u.id = p.author_id
WHERE p.deleted_at IS NULL AND p.author_id = :authorId
ORDER BY p.id DESC;

/* @name createPost */
INSERT INTO posts (author_id, title, tags, meta)
VALUES (:authorId, :title, :tags, :meta)
RETURNING id;
