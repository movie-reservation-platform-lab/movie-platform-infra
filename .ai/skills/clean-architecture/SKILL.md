---
name: clean-architecture
description: Use when designing or refactoring infrastructure control-plane automation around clean architecture, SOLID principles, dependency inversion, and explicit ports and adapters; do not force service layers onto straightforward CDK construct code.
---

Clean Architecture Skill

Comprehensive guide for implementing Clean Architecture, SOLID principles, and maintainable code structures.

Infrastructure Repository Application

Use these principles selectively in this repository:

    Apply them to control-plane automation with meaningful policy and workflow
    logic, such as account preflight, artifact inspection, admission, evidence,
    and cleanup tooling.
    Keep domain decisions and orchestration independent from AWS CLI, SDK,
    filesystem, process, and terminal-reporting adapters.
    Treat each executable entrypoint as a composition root that wires concrete
    adapters to focused ports.
    Do not manufacture domain, application, infrastructure, and presentation
    directories for simple CDK declarations. CDK stacks and constructs should
    remain direct and readable unless a real policy boundary justifies an
    extracted abstraction.

When to Use This Skill

    Designing new service architecture
    Refactoring legacy code to clean architecture
    Implementing dependency injection
    Defining domain boundaries and layer separation
    Applying SOLID principles
    Reviewing architectural decisions

Architecture Layers
The Dependency Rule

Dependencies point inward. Inner layers must not know about outer layers.

┌─────────────────────────────────────────────────┐
│  External Layer (Web, CLI, GraphQL)             │
│  ┌───────────────────────────────────────────┐  │
│  │ Infrastructure (Repos, Adapters, ORM)     │  │
│  │ ┌───────────────────────────────────────┐ │  │
│  │ │ Application (Use Cases, Services)     │ │  │
│  │ │ ┌───────────────────────────────────┐ │ │  │
│  │ │ │ Domain (Entities, VOs, Services)  │ │ │  │
│  │ │ └───────────────────────────────────┘ │ │  │
│  │ └───────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
        Dependencies point INWARD

1. Domain Layer

Business rules isolated from technical concerns:

    Entities: Objects with identity, business logic
    Value Objects: Immutable objects without identity
    Domain Services: Stateless operations on domain objects
    Repository Interfaces: Data access contracts

// Entity with behavior
export class User {
  constructor(
    public readonly id: UserId,
    private passwordHash: PasswordHash
  ) {}

  changePassword(newPassword: Password, hasher: PasswordHasher): void {
    this.passwordHash = hasher.hash(newPassword);
  }
}

// Value Object - immutable, validated
export class Email {
  private constructor(private readonly value: string) {}

  static create(email: string): Email {
    if (!this.isValid(email)) throw new InvalidEmailError(email);
    return new Email(email.toLowerCase());
  }

  private static isValid(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}

// Repository interface - defines contract
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  save(user: User): Promise<void>;
}

2. Application Layer

Orchestrates domain objects for use cases:

    Use Cases: Single responsibility operations
    DTOs: Data transfer at boundaries
    Ports: Interfaces for external dependencies

Repository/project convention:

    In this repository's automation packages, the policy or orchestration code
    owns the focused interface it needs. AWS CLI, SDK, process, filesystem, and
    report adapters implement those ports at the package edge. Executable CLI
    modules validate untrusted input and wire the concrete implementations.

    Do not move every external-operation interface into a domain folder by
    default. Put a contract in the innermost layer that needs it. Keep direct CDK
    construct composition outside this layering unless it contains independently
    testable policy or workflow behavior.

export class CreateUserUseCase {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly passwordHasher: PasswordHasher
  ) {}

  async execute(input: CreateUserInput): Promise<CreateUserOutput> {
    const existing = await this.userRepository.findByEmail(
      Email.create(input.email)
    );
    if (existing) throw new EmailAlreadyExistsError();

    const user = new User(
      UserId.generate(),
      Email.create(input.email),
      this.passwordHasher.hash(input.password),
      new Date()
    );

    await this.userRepository.save(user);
    return user.toDTO();
  }
}

3. Infrastructure Layer

Implements interfaces from inner layers:

    Repository Implementations: Database access
    External Adapters: Third-party integrations
    ORM/Query Builders: Data persistence

export class PostgreSQLUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: UserId): Promise<User | null> {
    const row = await this.db.query('SELECT * FROM users WHERE id = $1', [id.toString()]);
    return row ? this.toDomain(row) : null;
  }

  async save(user: User): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email = $2`,
      [user.id.toString(), user.email.toString(), user.passwordHash]
    );
  }

  private toDomain(row: UserRow): User {
    return new User(UserId.fromString(row.id), PasswordHash.fromString(row.password_hash));
  }
}

4. Presentation Layer

Entry points to the application:

    Controllers: HTTP handlers
    Resolvers: GraphQL endpoints
    CLI Commands: Command-line interfaces

export class UserController {
  constructor(private readonly createUserUseCase: CreateUserUseCase) {}

  async create(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.createUserUseCase.execute(req.body);
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof EmailAlreadyExistsError) {
        res.status(409).json({ error: error.message });
      }
    }
  }
}

Project Structure

src/
├── domain/
│   ├── entities/          (User, Order)
│   ├── value-objects/     (Email, Money, UserId)
│   ├── services/          (PricingService)
│   ├── repositories/      (Interfaces only)
│   └── errors/
├── application/
│   ├── use-cases/         (CreateUser, UpdateOrder)
│   ├── services/          (NotificationService)
│   ├── ports/             (EmailPort, PaymentPort)
│   └── dto/
├── infrastructure/
│   ├── repositories/      (PostgreSQL, MongoDB implementations)
│   ├── adapters/          (SendGrid, Stripe)
│   ├── orm/
│   └── config/
├── presentation/
│   ├── http/              (Controllers, Routes, Middleware)
│   ├── graphql/           (Resolvers)
│   └── cli/               (Commands)
├── shared/                (Utilities, Kernel helpers)
└── container/             (Dependency Injection setup)

Dependency Injection

// src/container/container.ts
import { Container } from 'inversify';

const container = new Container();

// Bind implementations to interfaces
container.bind<UserRepository>(TYPES.UserRepository)
  .to(PostgreSQLUserRepository)
  .inSingletonScope();

container.bind<CreateUserUseCase>(TYPES.CreateUserUseCase)
  .to(CreateUserUseCase)
  .inTransientScope();

container.bind<UserController>(TYPES.UserController)
  .to(UserController)
  .inTransientScope();

export { container };

SOLID Principles
Single Responsibility

Each layer has one reason to change:

    Domain: Business rules
    Application: Use case coordination
    Infrastructure: Technical implementations
    Presentation: User interface

Open/Closed

Add features by creating new use cases, not modifying existing:

export class UpdateUserUseCase { /* ... */ }

Liskov Substitution

Repository implementations are fully interchangeable:

const repo: UserRepository = new PostgreSQLUserRepository(db);
const repo: UserRepository = new MongoUserRepository(client);
// Both satisfy the contract

Interface Segregation

Use focused interfaces, not fat ones:

// Good: Segregated
interface UserCreator { create(data): User; }
interface UserDeleter { delete(id): void; }

// Bad: Fat interface
interface UserService {
  create(): User;
  update(): User;
  delete(): void;
  sendEmail(): void;
  generateReport(): Report;
}

Dependency Inversion

Depend on abstractions, not implementations:

// Application defines the port
export interface EmailPort {
  send(to: string, subject: string, body: string): Promise<void>;
}

// Infrastructure implements
export class SendGridAdapter implements EmailPort {
  async send(to: string, subject: string, body: string): Promise<void> {
    await this.sendgrid.send({ to, subject, text: body });
  }
}

// Use cases depend on port
export class CreateUserUseCase {
  constructor(private readonly emailPort: EmailPort) {}
}

Testing

// Unit: Domain logic without infrastructure
describe('User', () => {
  it('should change password', () => {
    const hasher = new BCryptHasher();
    const user = new User(UserId.generate(), hasher.hash('oldpass'));
    user.changePassword(Password.create('newpass'), hasher);
    expect(user.validatePassword(Password.create('newpass'), hasher)).toBe(true);
  });
});

// Integration: Infrastructure with real DB
describe('PostgreSQLUserRepository', () => {
  it('should save and retrieve user', async () => {
    const repo = new PostgreSQLUserRepository(testDb);
    const user = createTestUser();
    await repo.save(user);
    const retrieved = await repo.findById(user.id);
    expect(retrieved).not.toBeNull();
  });
});

// E2E: Full stack via HTTP
describe('User API', () => {
  it('should create user via POST', async () => {
    const response = await request(app).post('/api/users').send({
      email: 'test@example.com',
      password: 'secure123'
    });
    expect(response.status).toBe(201);
  });
});

Anti-Patterns
Domain Logic in Controllers

// Bad: Business logic in controller
async create(req, res) {
  if (await this.db.query('SELECT * FROM users WHERE email = $1', [req.body.email])) {
    return res.status(409).json({ error: 'Email exists' });
  }
}

// Good: Delegate to use case
async create(req, res) {
  const result = await this.createUserUseCase.execute(req.body);
  res.status(201).json(result);
}

Infrastructure in Domain

// Bad: Infrastructure leak in entity
class User {
  async save() {
    await prisma.user.create({ data: this });
  }
}

// Good: Repository handles persistence
class User { /* pure domain */ }
class UserRepository {
  async save(user: User) { await prisma.user.create(...); }
}

Anemic Domain Model

// Bad: Entity is just data
class User {
  id: string;
  password: string;
}
class UserService {
  changePassword(user: User, pwd: string) {
    user.password = hash(pwd);  // Logic outside entity
  }
}

// Good: Rich domain model
class User {
  changePassword(newPassword: Password, hasher: PasswordHasher): void {
    if (!newPassword.isStrong()) throw new WeakPasswordError();
    this.passwordHash = hasher.hash(newPassword);
  }
}

Migration Path (Legacy → Clean Architecture)

    Identify Boundaries: Find domain concepts
    Extract Entities: Create domain objects with behavior
    Define Interfaces: Create repository/port interfaces
    Implement Adapters: Wrap existing data access
    Create Use Cases: Extract business logic
    Refactor Controllers: Delegate to use cases
    Add DI Container: Wire dependencies
    Write Tests: Cover each layer

Quick Checklist

    Domain is infrastructure-free
    All dependencies point inward
    Use cases are thin orchestrators
    Repository interfaces in domain
    Implementations in infrastructure
    Controllers delegate to use cases
    DTOs at layer boundaries
    Comprehensive test coverage (unit, integration, e2e)
    DI container wires all dependencies
    No anemic domain models
