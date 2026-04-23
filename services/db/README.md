# DB

Database workspace for Plato services, migrations, and persistence logic.

Right now this workspace provides the shared SQLite foundation that local services can reuse:

- opening embedded SQLite databases
- enabling core connection pragmas
- running idempotent schema bootstrap or migration callbacks
- closing connections in tests and local tooling

Service-specific tables and queries should stay in the service that owns the domain. `services/db` should stay generic unless a cross-service persistence concern is clearly reusable.
