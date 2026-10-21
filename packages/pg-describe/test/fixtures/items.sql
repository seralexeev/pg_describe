/* @name insertItem */
INSERT INTO items (id, title, kind, note, payload)
VALUES (:id, :title, :kind, :note, :payload);

/* @name getItem */
SELECT id, title, kind, note, payload
FROM items
WHERE id = :id;

/* @name countItems */
SELECT count(*)::int AS total FROM items;

/* @name listItems */
SELECT id, title FROM items WHERE kind = :kind OR :kind IS NULL ORDER BY id;
