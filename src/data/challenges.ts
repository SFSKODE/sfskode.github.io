// Guided challenges for the Playground. Every check is evaluated in the browser against the REAL response from the
// learner's org, so they work in any org (none depends on specific records existing).
export type Level = 'Beginner' | 'Intermediate' | 'Advanced';
export type Check =
  | { type: 'matches'; re: string; label: string; flags?: string } // the code must match
  | { type: 'runs'; label: string } // SOQL succeeded / Apex compiled and finished without an exception
  | { type: 'columns'; names: string[]; label: string } // result must contain these (flattened) columns
  | { type: 'maxRows'; n: number; label: string }
  | { type: 'sorted'; field: string; dir: 'asc' | 'desc'; label: string } // returned rows must be ordered (only judged with 2+ rows)
  | { type: 'log'; contains: string; label: string }; // Apex debug log must contain the text

export interface Challenge {
  id: string;
  title: string;
  kind: 'soql' | 'apex';
  level: Level;
  track: 'salesforce-development' | 'salesforce-administration';
  article: string; // slug of the related article
  story: string;
  starter: string;
  hints: string[];
  checks: Check[];
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'soql-first-query', title: 'Your first query', kind: 'soql', level: 'Beginner', track: 'salesforce-administration', article: 'salesforce-data-model-and-relationships',
    story: 'Every Salesforce record lives in an object. Ask the **Account** object for its record Id and Name, and return only **5** rows.',
    starter: '-- Return the Id and Name of 5 accounts\nSELECT ',
    hints: ['A query has the shape SELECT fields FROM Object.', 'Add LIMIT 5 at the very end to cap the rows.', 'SELECT Id, Name FROM Account LIMIT 5'],
    checks: [
      { type: 'matches', re: 'select\\s+[\\s\\S]*\\bid\\b[\\s\\S]*\\bname\\b[\\s\\S]*from\\s+account\\b', label: 'selects Id and Name FROM Account' },
      { type: 'matches', re: 'limit\\s+5\\b', label: 'uses LIMIT 5' },
      { type: 'runs', label: 'query runs in your org' },
      { type: 'maxRows', n: 5, label: 'returns at most 5 rows' },
    ],
  },
  {
    id: 'soql-filter', title: 'Filter with WHERE', kind: 'soql', level: 'Beginner', track: 'salesforce-administration', article: 'salesforce-data-model-and-relationships',
    story: 'Find accounts in the **Technology** industry. Return Name and Industry. Text values go in single quotes.',
    starter: 'SELECT Name, Industry\nFROM Account\n',
    hints: ['WHERE comes after FROM.', "Compare with = and quote the text: Industry = 'Technology'", "SELECT Name, Industry FROM Account WHERE Industry = 'Technology'"],
    checks: [
      { type: 'matches', re: "where[\\s\\S]*industry\\s*=\\s*'technology'", label: "filters Industry = 'Technology'" },
      { type: 'runs', label: 'query runs in your org' },
      { type: 'columns', names: ['Name', 'Industry'], label: 'returns Name and Industry' },
    ],
  },
  {
    id: 'soql-order-limit', title: 'Top 3 deals', kind: 'soql', level: 'Beginner', track: 'salesforce-administration', article: 'salesforce-data-model-and-relationships',
    story: 'Show the **three biggest opportunities**: Name, Amount and StageName, largest Amount first.',
    starter: 'SELECT Name, Amount, StageName\nFROM Opportunity\n',
    hints: ['ORDER BY sorts. Add DESC for largest first.', 'Then cap with LIMIT 3.', 'SELECT Name, Amount, StageName FROM Opportunity ORDER BY Amount DESC LIMIT 3'],
    checks: [
      { type: 'matches', re: 'order\\s+by\\s+amount\\s+desc', label: 'ORDER BY Amount DESC' },
      { type: 'matches', re: 'limit\\s+3\\b', label: 'LIMIT 3' },
      { type: 'runs', label: 'query runs in your org' },
      { type: 'sorted', field: 'Amount', dir: 'desc', label: 'rows come back largest first' },
    ],
  },
  {
    id: 'soql-parent', title: 'Reach up to the parent', kind: 'soql', level: 'Intermediate', track: 'salesforce-administration', article: 'salesforce-data-model-and-relationships',
    story: 'List contacts with their **account name** in the same row. Use dot notation to traverse the lookup: no join needed. Return FirstName, LastName and the Account name for 10 contacts.',
    starter: 'SELECT FirstName, LastName\nFROM Contact\n',
    hints: ['A lookup field named AccountId has a relationship called Account.', 'Add Account.Name to the SELECT list.', 'SELECT FirstName, LastName, Account.Name FROM Contact LIMIT 10'],
    checks: [
      { type: 'matches', re: 'account\\.name', label: 'selects Account.Name' },
      { type: 'matches', re: 'from\\s+contact\\b', label: 'FROM Contact' },
      { type: 'runs', label: 'query runs in your org' },
      { type: 'maxRows', n: 10, label: 'returns at most 10 rows' },
    ],
  },
  {
    id: 'soql-aggregate', title: 'Count by stage', kind: 'soql', level: 'Intermediate', track: 'salesforce-development', article: 'dynamic-soql-sosl-and-schema-describe',
    story: 'How many opportunities sit in each **StageName**? Group them and count each group.',
    starter: 'SELECT StageName, COUNT(Id)\nFROM Opportunity\n',
    hints: ['Aggregates need GROUP BY for every non-aggregate field.', 'GROUP BY StageName', 'SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName'],
    checks: [
      { type: 'matches', re: 'count\\s*\\(', label: 'uses COUNT()' },
      { type: 'matches', re: 'group\\s+by\\s+stagename', label: 'GROUP BY StageName' },
      { type: 'runs', label: 'query runs in your org' },
    ],
  },
  {
    id: 'soql-subquery', title: 'Parents with their children', kind: 'soql', level: 'Intermediate', track: 'salesforce-development', article: 'salesforce-data-model-and-relationships',
    story: 'Return each account with its **contacts nested inside** the row. A subquery uses the *child relationship name* (Contacts), not the object name.',
    starter: 'SELECT Name,\n  (SELECT ',
    hints: ['Wrap a second SELECT in parentheses inside the first SELECT list.', 'The FROM of the subquery is the plural child relationship: Contacts.', 'SELECT Name, (SELECT FirstName, LastName FROM Contacts) FROM Account LIMIT 5'],
    checks: [
      { type: 'matches', re: '\\(\\s*select[\\s\\S]*from\\s+contacts\\s*\\)', label: 'has a (SELECT ... FROM Contacts) subquery' },
      { type: 'matches', re: 'from\\s+account\\b', label: 'outer query is FROM Account' },
      { type: 'runs', label: 'query runs in your org' },
    ],
  },
  {
    id: 'soql-dates', title: 'Date literals', kind: 'soql', level: 'Intermediate', track: 'salesforce-development', article: 'dynamic-soql-sosl-and-schema-describe',
    story: 'Find opportunities that **close this year**. Salesforce has built-in date literals so you never hard-code dates.',
    starter: 'SELECT Name, CloseDate, Amount\nFROM Opportunity\nWHERE ',
    hints: ['Try the literal THIS_YEAR.', 'CloseDate = THIS_YEAR (no quotes around a date literal).', 'SELECT Name, CloseDate, Amount FROM Opportunity WHERE CloseDate = THIS_YEAR'],
    checks: [
      { type: 'matches', re: 'closedate\\s*=\\s*this_year\\b', label: 'CloseDate = THIS_YEAR' },
      { type: 'runs', label: 'query runs in your org' },
    ],
  },
  {
    id: 'soql-like-in', title: 'LIKE and IN together', kind: 'soql', level: 'Intermediate', track: 'salesforce-development', article: 'dynamic-soql-sosl-and-schema-describe',
    story: "Find leads whose **Company starts with the letter A** and whose Status is **Open** or **Working**.",
    starter: 'SELECT Name, Company, Status\nFROM Lead\nWHERE ',
    hints: ["LIKE uses % as a wildcard: Company LIKE 'A%'", "IN takes a list: Status IN ('Open', 'Working')", "SELECT Name, Company, Status FROM Lead WHERE Company LIKE 'A%' AND Status IN ('Open', 'Working')"],
    checks: [
      { type: 'matches', re: "company\\s+like\\s+'a%'", label: "Company LIKE 'A%'" },
      { type: 'matches', re: "status\\s+in\\s*\\(\\s*'open'\\s*,\\s*'working'\\s*\\)", label: "Status IN ('Open', 'Working')" },
      { type: 'runs', label: 'query runs in your org' },
    ],
  },
  {
    id: 'apex-hello', title: 'Hello, debug log', kind: 'apex', level: 'Beginner', track: 'salesforce-development', article: 'apex-classes-zero-to-hero',
    story: 'Apex has no console, so developers print with **System.debug**. Write one line that logs exactly `Hello, Trailblazer!`, then find it in the Log tab.',
    starter: '// Print a greeting to the debug log\n',
    hints: ['System.debug takes any value.', "System.debug('Hello, Trailblazer!');", "Remember the semicolon at the end of every statement."],
    checks: [
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Hello, Trailblazer!', label: 'the log contains "Hello, Trailblazer!"' },
    ],
  },
  {
    id: 'apex-loop-sum', title: 'Loop and total', kind: 'apex', level: 'Beginner', track: 'salesforce-development', article: 'apex-classes-zero-to-hero',
    story: 'Given a list of Integers, add them up in a **for loop** and log `Total: 60`.',
    starter: 'List<Integer> nums = new List<Integer>{ 10, 20, 30 };\n// add them up and print: Total: 60\n',
    hints: ['Declare Integer total = 0; then for (Integer n : nums) { total += n; }', "Log it with System.debug('Total: ' + total);", "Integer total = 0;\nfor (Integer n : nums) { total += n; }\nSystem.debug('Total: ' + total);"],
    checks: [
      { type: 'matches', re: '\\bfor\\s*\\(', label: 'uses a for loop' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Total: 60', label: 'the log contains "Total: 60"' },
    ],
  },
  {
    id: 'apex-inline-soql', title: 'Query inside Apex', kind: 'apex', level: 'Intermediate', track: 'salesforce-development', article: 'apex-governor-limits-cheat-sheet',
    story: 'Run a **SOQL query inside Apex** (square brackets), store the rows in a List, and log how many came back: `Found: <number>`.',
    starter: '// Query up to 10 accounts and log how many you found\n',
    hints: ['List<Account> accts = [SELECT Id, Name FROM Account LIMIT 10];', "System.debug('Found: ' + accts.size());", "List<Account> accts = [SELECT Id, Name FROM Account LIMIT 10];\nSystem.debug('Found: ' + accts.size());"],
    checks: [
      { type: 'matches', re: '\\[\\s*select[\\s\\S]*from\\s+account', label: 'has an inline [SELECT ... FROM Account]' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Found: ', label: 'the log contains "Found: "' },
      { type: 'log', contains: 'SOQL_EXECUTE_BEGIN', label: 'the log shows the SOQL actually ran' },
    ],
  },
  {
    id: 'apex-savepoint', title: 'DML you can undo', kind: 'apex', level: 'Intermediate', track: 'salesforce-development', article: 'apex-exception-handling-and-logging',
    story: 'Insert a test Account, then **roll it back** with a savepoint so your org stays clean. Log `Rolled back`.',
    starter: 'Savepoint sp = Database.setSavepoint();\n// insert an Account named "Playground Test"\n// roll back to sp, then log: Rolled back\n',
    hints: ["insert new Account(Name = 'Playground Test');", 'Database.rollback(sp);', "Savepoint sp = Database.setSavepoint();\ninsert new Account(Name = 'Playground Test');\nDatabase.rollback(sp);\nSystem.debug('Rolled back');"],
    checks: [
      { type: 'matches', re: 'database\\.setsavepoint\\s*\\(', label: 'sets a savepoint' },
      { type: 'matches', re: 'database\\.rollback\\s*\\(\\s*\\w+\\s*\\)', label: 'rolls back to it' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'DML_BEGIN', label: 'the log shows the insert happened' },
      { type: 'log', contains: 'Rolled back', label: 'the log contains "Rolled back"' },
    ],
  },
  {
    id: 'apex-try-catch', title: 'Catch the exception', kind: 'apex', level: 'Intermediate', track: 'salesforce-development', article: 'apex-exception-handling-and-logging',
    story: 'This code crashes. Wrap it in **try / catch**, and in the catch block log `Caught: ` plus the exception message. The run must finish **without** an unhandled exception.',
    starter: 'Account a;\nSystem.debug(a.Name); // NullPointerException\n',
    hints: ['try { ... } catch (Exception e) { ... }', "System.debug('Caught: ' + e.getMessage());", "Account a;\ntry {\n  System.debug(a.Name);\n} catch (Exception e) {\n  System.debug('Caught: ' + e.getMessage());\n}"],
    checks: [
      { type: 'matches', re: 'try\\s*\\{[\\s\\S]*\\}\\s*catch\\s*\\(', label: 'has a try / catch' },
      { type: 'runs', label: 'finishes without an unhandled exception' },
      { type: 'log', contains: 'Caught: ', label: 'the log contains "Caught: "' },
    ],
  },
  {
    id: 'apex-limits', title: 'Watch the governor', kind: 'apex', level: 'Intermediate', track: 'salesforce-development', article: 'apex-governor-limits-cheat-sheet',
    story: 'Run a query, then log how many SOQL queries you have used and your limit: `Queries: 1 of 100`. The Limits class reports live numbers.',
    starter: 'List<Contact> c = [SELECT Id FROM Contact LIMIT 5];\n',
    hints: ['Limits.getQueries() is used so far; Limits.getLimitQueries() is the cap.', "System.debug('Queries: ' + Limits.getQueries() + ' of ' + Limits.getLimitQueries());", "List<Contact> c = [SELECT Id FROM Contact LIMIT 5];\nSystem.debug('Queries: ' + Limits.getQueries() + ' of ' + Limits.getLimitQueries());"],
    checks: [
      { type: 'matches', re: 'limits\\.getqueries\\s*\\(\\s*\\)', label: 'uses Limits.getQueries()' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Queries: 1 of', label: 'the log contains "Queries: 1 of"' },
    ],
  },
  {
    id: 'apex-map-bulk', title: 'Bulk-safe lookups with a Map', kind: 'apex', level: 'Advanced', track: 'salesforce-development', article: 'bulkify-apex-triggers',
    story: 'Never query inside a loop. Build a **Map<Id, Account>** straight from one query, then log its size as `Map size: <n>`.',
    starter: '// One query, one map, no loops\n',
    hints: ['A Map can be built from a query: new Map<Id, Account>([SELECT ...])', "System.debug('Map size: ' + m.size());", "Map<Id, Account> m = new Map<Id, Account>([SELECT Id, Name FROM Account LIMIT 20]);\nSystem.debug('Map size: ' + m.size());"],
    checks: [
      { type: 'matches', re: 'map\\s*<\\s*id\\s*,\\s*account\\s*>', label: 'declares a Map<Id, Account>' },
      { type: 'matches', re: 'new\\s+map\\s*<[^>]+>\\s*\\(\\s*\\[\\s*select', label: 'builds it from a SOQL query' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Map size: ', label: 'the log contains "Map size: "' },
    ],
  },
  {
    id: 'apex-dynamic-soql', title: 'Dynamic SOQL, safely', kind: 'apex', level: 'Advanced', track: 'salesforce-development', article: 'dynamic-soql-sosl-and-schema-describe',
    story: 'Build a query from a variable using **Database.query**, and use a **bind variable** (`:name`) so user input can never inject SQL-like text. Log `Dynamic rows: <n>`.',
    starter: "String name = 'Acme%';\n// query accounts whose Name LIKE :name\n",
    hints: ["List<Account> r = Database.query('SELECT Id FROM Account WHERE Name LIKE :name');", "System.debug('Dynamic rows: ' + r.size());", "String name = 'Acme%';\nList<Account> r = Database.query('SELECT Id FROM Account WHERE Name LIKE :name');\nSystem.debug('Dynamic rows: ' + r.size());"],
    checks: [
      { type: 'matches', re: 'database\\.query\\s*\\(', label: 'uses Database.query' },
      { type: 'matches', re: ':\\s*name\\b', label: 'uses the bind variable :name' },
      { type: 'runs', label: 'code compiles and runs without an exception' },
      { type: 'log', contains: 'Dynamic rows: ', label: 'the log contains "Dynamic rows: "' },
    ],
  },
];
