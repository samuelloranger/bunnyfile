CREATE VIRTUAL TABLE IF NOT EXISTS `file_search` USING fts5(
  `path` UNINDEXED,
  `name`,
  tokenize = 'unicode61 remove_diacritics 2'
);
