// Starter library shown in the Playground's "Library" tab.
export interface Example { name: string; code: string; note?: string }
export const EXAMPLES: { soql: Example[]; apex: Example[] } = {
  soql: [
    { name: 'Latest accounts', note: 'SELECT, ORDER BY, LIMIT', code: 'SELECT Id, Name, Industry, CreatedDate\nFROM Account\nORDER BY CreatedDate DESC\nLIMIT 10' },
    { name: 'Contacts with account', note: 'parent field with dot notation', code: 'SELECT FirstName, LastName, Email, Account.Name\nFROM Contact\nWHERE Email != null\nLIMIT 20' },
    { name: 'Accounts with their contacts', note: 'child subquery', code: 'SELECT Name,\n  (SELECT FirstName, LastName FROM Contacts)\nFROM Account\nLIMIT 5' },
    { name: 'Pipeline by stage', note: 'GROUP BY with SUM and COUNT', code: 'SELECT StageName, COUNT(Id) deals, SUM(Amount) total\nFROM Opportunity\nGROUP BY StageName\nORDER BY SUM(Amount) DESC' },
    { name: 'Closing this quarter', note: 'date literal', code: 'SELECT Name, Amount, CloseDate\nFROM Opportunity\nWHERE CloseDate = THIS_QUARTER\nORDER BY CloseDate' },
    { name: 'Count all leads', note: 'COUNT()', code: 'SELECT COUNT()\nFROM Lead' },
    { name: 'Who am I', note: 'the logged in user', code: 'SELECT Id, Name, Username, Profile.Name\nFROM User\nWHERE Id = UserInfo.getUserId()' },
    { name: 'Apex classes (Tooling API)', note: 'tick Tooling API', code: 'SELECT Name, ApiVersion, LengthWithoutComments\nFROM ApexClass\nORDER BY LengthWithoutComments DESC\nLIMIT 10' },
  ],
  apex: [
    { name: 'Hello, debug log', note: 'System.debug', code: "System.debug('Hello from the Playground!');\nSystem.debug(UserInfo.getUserName());" },
    { name: 'Loop over a query', note: 'SOQL in Apex, for loop', code: "List<Account> accts = [SELECT Id, Name FROM Account LIMIT 5];\nfor (Account a : accts) {\n  System.debug('Account: ' + a.Name);\n}\nSystem.debug('Total: ' + accts.size());" },
    { name: 'Insert and roll back', note: 'safe DML with a savepoint', code: "Savepoint sp = Database.setSavepoint();\ninsert new Account(Name = 'Playground Test');\nSystem.debug('Inside transaction: ' + [SELECT COUNT() FROM Account WHERE Name = 'Playground Test']);\nDatabase.rollback(sp);\nSystem.debug('After rollback: ' + [SELECT COUNT() FROM Account WHERE Name = 'Playground Test']);" },
    { name: 'Collections', note: 'List, Set, Map', code: "List<String> names = new List<String>{ 'Aarav', 'Diya', 'Kabir' };\nSet<String> unique = new Set<String>(names);\nMap<String, Integer> lengths = new Map<String, Integer>();\nfor (String n : names) {\n  lengths.put(n, n.length());\n}\nSystem.debug(lengths);" },
    { name: 'Try and catch', note: 'exception handling', code: "try {\n  Account a;\n  System.debug(a.Name);\n} catch (NullPointerException e) {\n  System.debug('Caught: ' + e.getMessage());\n}" },
    { name: 'Governor limits', note: 'Limits class', code: "List<Contact> c = [SELECT Id FROM Contact LIMIT 50];\nSystem.debug('SOQL: ' + Limits.getQueries() + '/' + Limits.getLimitQueries());\nSystem.debug('Rows: ' + Limits.getQueryRows() + '/' + Limits.getLimitQueryRows());\nSystem.debug('CPU: ' + Limits.getCpuTime() + ' ms');" },
    { name: 'Dynamic SOQL', note: 'Database.query with bind', code: "String term = 'A%';\nList<SObject> rows = Database.query('SELECT Id, Name FROM Account WHERE Name LIKE :term LIMIT 5');\nSystem.debug(rows.size() + ' rows');" },
    { name: 'JSON round trip', note: 'serialize and deserialize', code: "Map<String, Object> m = new Map<String, Object>{ 'name' => 'Acme', 'employees' => 120 };\nString s = JSON.serialize(m);\nSystem.debug(s);\nSystem.debug(JSON.deserializeUntyped(s));" },
  ],
};
