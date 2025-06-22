# serverless-iam-test-helper
Helper that allows easy testing of AWS Lambda IAM roles that were created in Serverless Framework project using `serverless-iam-roles-per-function` plugin. Works with `jest` testing framework.

# Compatibility with AWS SDK
The current version `>= 1.0.0` of this library works with AWS SDK v3. For AWS SDK v2 compatibility use version `0.0.4`.

# Features
- ✅ **AWS SDK v3 Support**: Full compatibility with the latest AWS SDK
- ✅ **SSO Support**: Automatic detection and handling of AWS SSO profiles
- ✅ **High-level API**: Simplified methods for common testing patterns
- ✅ **Automatic Cleanup**: Built-in credential restoration after tests
- ✅ **Jest Integration**: Seamless integration with Jest testing framework

# How to use?
## 1. Install as a dev dependency
```
npm i -D serverless-iam-test-helper
```
## 2. Make sure there is a dedicated role per function
This library works with IAM role naming convention defined by [serverless-iam-roles-per-function](https://github.com/functionalone/serverless-iam-roles-per-function) plugin. Make sure you're using it.

## 3. Write tests in `jest`

### Option A: Using the High-level API (Recommended)

The easiest way to use this library is with the new high-level API methods that automatically handle setup and cleanup:

```JavaScript
import IamTestHelper from 'serverless-iam-test-helper';

// Using describeWithRole for automatic describe() + role assumption
IamTestHelper.describeWithRole(
  'CreateItem Lambda IAM Role Tests', 
  'createItem', // Lambda function name
  () => {
    it('should ALLOW dynamodb:PutItem', async () => {
      // Your test code here - role is already assumed
      const service = new MyEntityService()
      const result = await service.create({ id: 'test' })
      expect(result).toBeDefined()
    })

    it('should DENY dynamodb:DeleteItem', async () => {
      // Test that certain operations are blocked
      const service = new MyEntityService()
      let exception
      try {
        await service.delete({ id: 'test' })
      } catch (error) {
        exception = error
      }
      expect(exception.name).toBe('AccessDeniedException')
    })
  }
)
```

Or use `withAssumedRole` within your own describe block:

```JavaScript
import IamTestHelper from 'serverless-iam-test-helper';

describe('My Lambda Tests', () => {
  IamTestHelper.withAssumedRole('createItem', () => {
    it('should work with assumed role', async () => {
      // Your test code here
    })
  })
})
```

### Option B: Manual Setup (Traditional approach)

If you need more control, you can still use the traditional manual setup:

```JavaScript
import IamTestHelper from 'serverless-iam-test-helper';

describe('<LAMBDA_LOGICAL_NAME> Lambda IAM Role', () => {
  let iamHelper;

  beforeAll(async () => {
    iamHelper = await IamTestHelper.assumeRoleByLambdaName('<LAMBDA_LOGICAL_NAME>')
  });

  afterAll(async () => {
    if (iamHelper) {
      await iamHelper.assumeUserRoleBack();
    }
  });

 // tests go here
})
```

### Testing with Cleanup

You can provide a cleanup function that runs after credentials are restored:

```JavaScript
IamTestHelper.describeWithRole(
  'CreateItem Lambda IAM Role Tests', 
  'createItem',
  () => {
    const itemsToCleanup = [];

    it('should create item', async () => {
      const service = new MyEntityService()
      const result = await service.create({ id: 'test' })
      itemsToCleanup.push(result.id);
      expect(result).toBeDefined()
    })
  },
  {
    cleanup: async () => {
      // This runs after credentials are restored to your original profile
      const adminService = new MyEntityService()
      for (const id of itemsToCleanup) {
        await adminService.delete({ id })
      }
    }
  }
)
```

## AWS SSO Support

This library automatically detects and handles AWS SSO profiles. No additional configuration is needed:

- **Automatic Detection**: Detects SSO profiles from environment variables and caller identity
- **Token Management**: Handles SSO token expiration gracefully
- **Credential Restoration**: Properly restores SSO profile credentials after tests

If you're using AWS SSO and encounter token expiration errors, run:
```bash
aws sso login --profile <your-profile>
```

## Testing Patterns

### Testing Allowed Operations
```JavaScript
it('should ALLOW <an operation that should be allowed>', async () => {
  // GIVEN
  const payload = { ... }
  const service = new Service()

  // WHEN
  const actual = await service.operation(payload)

  // THEN
  expect(actual).toBe(...)
})
```

### Testing Denied Operations
```JavaScript
it('should DENY dynamodb:Query', async () => {
  // GIVEN
  const payload = { ... }
  const service = new MyEntityService()

  // WHEN
  let exception
  try {
    await service.getByQuery(payload)
  } catch (error) {
    exception = error
  }

  // THEN
  expect(exception.name).toBe('AccessDeniedException') // AWS SDK v3 convention
  expect(exception.message.includes('is not authorized to perform: dynamodb:Query')).toBeTruthy()
})
```

The `LAMBDA_LOGICAL_NAME` is the same as defined in the `serverless.yml` in `functions` section. It is crucial to pass correct Lambda name to `assumeRoleByLambdaName()` method.

# How does it work?
The logic behind it is pretty simple. Instead of executing *integration tests* using your *AWS profile* (IAM user), which usually has admin privileges, and is defined in `~/.aws/credentials` file. 

I temporarily *assume* Lambda's IAM Role and execute the whole test suite within that role context. Any AWS SDK operation that your code wants to execute is checked by the IAM service. Depending on  Lambda's IAM Role configuration it is *allowed* or *denied*.

Test suites run in an isolated fashion, that's why you may have multiple tests when each assumes other Lambda's role. After tests finish your own role (IAM user) is still present. **This does not override any of your local settings nor environment variables**.

The library intelligently handles different authentication methods:
- **Regular AWS Profiles**: Uses session tokens for credential management
- **AWS SSO Profiles**: Automatically detects SSO and handles credential restoration without conflicts

You will get the **best results** when using that approach in projects that follow *hexagonal architecture*, so you can easily test in isolation parts (modules) of your application. Check out this [serverless-hexagonal-template](https://github.com/serverlesspolska/serverless-hexagonal-template) for Serverless Framework and an article describing [why and how to use it](https://dev.to/pzubkiewicz/testing-serverless-apps-has-never-been-easier-442m).

### Test compensation (Legacy approach)
The *test compensation* is an approach when test cleans up after itself. The `IamTestHelper` class provides a `static` method named `leaveLambdaRole()` and an alias `assumeUserRoleBack()`, which allows assuming your own (local IAM user) role back. 

**Note**: With the new high-level API methods (`withAssumedRole` and `describeWithRole`), this manual cleanup is handled automatically. The legacy approach below is still supported but not recommended for new code.

That proves to be useful when you test a Lambda IAM Role that is allowed **only** to create elements (i.e. in DynamoDB database) but you want to perform a cleanup of sorts after the test, so there aren't any leftovers after test execution.

My pattern to achieve that is depicted by code below:
```JavaScript
import IamTestHelper from 'serverless-iam-test-helper';
// rest of imports

const cleanup = []

describe('<LAMBDA_LOGICAL_NAME> Lambda IAM Role', () => {
  
  beforeAll(async () => {
    await IamTestHelper.assumeRoleByLambdaName('<LAMBDA_LOGICAL_NAME>')
  });
 
 it('should ALLOW dynamodb:PutItem', async () => {
    // GIVEN
    const payload = { ... }
    const service = new MyEntityService()

    // WHEN
    const actual = await service.create(payload)

    // THEN
    expect(actual).toBe(...)

     // CLEANUP
    cleanup.push(actual)
  });

 afterAll(async () => {
    IamTestHelper.leaveLambdaRole()

    const userRoleAdapter = new DynamoDbAdapter()
    const deleteAll = cleanup.map((obj) => userRoleAdapter.delete({
      Key: obj.key(),
      TableName: process.env.tableName
    }))
    await Promise.all(deleteAll)
  });

})

```
This allows me to delete items that I have created during tests using my own IAM user profile with administrative privileges even when Lambda's IAM Role is not allowed to delete elements from DynamoDB table.

This helps me to keep my table in order.

# API Reference

## High-level Methods (Recommended)

### `IamTestHelper.describeWithRole(description, lambdaName, testSuite, options)`
Combines `describe()` with automatic role assumption and cleanup.

**Parameters:**
- `description` (string): Test suite description
- `lambdaName` (string): Lambda function name from serverless.yml
- `testSuite` (function): Function containing your test cases
- `options` (object, optional): Configuration options
  - `cleanup` (function, optional): Cleanup function called after role is restored

### `IamTestHelper.withAssumedRole(lambdaName, testSuite, options)`
Handles role assumption and cleanup within an existing describe block.

**Parameters:**
- `lambdaName` (string): Lambda function name from serverless.yml
- `testSuite` (function): Function containing your test cases
- `options` (object, optional): Configuration options
  - `cleanup` (function, optional): Cleanup function called after role is restored

## Low-level Methods

### `IamTestHelper.assumeRoleByLambdaName(lambdaName)`
Assumes role based on Lambda function name.

### `IamTestHelper.assumeRoleByFullName(roleName)`
Assumes role by full IAM role name.

### `assumeUserRoleBack()`
Restores original credentials (instance method).

### `IamTestHelper.leaveLambdaRole()`
Restores original credentials (static method).

# Benefits

Using this approach has following advantages:

* Better security due to tailored IAM Roles
* Tests are executed locally against **real** services in the AWS cloud
* Works in your CI/CD pipeline
* Easier & faster development
* Easier maintenance of the project: IAM Role tests protect against *regression* bugs in case of modification
* **AWS SSO Support**: Works seamlessly with modern AWS SSO authentication
* **Simplified API**: High-level methods reduce boilerplate code
* **Automatic Cleanup**: No need to manually manage credential restoration

# Example
Working example is included in the [serverless-hexagonal-template](https://github.com/serverlesspolska/serverless-hexagonal-template) project. Follow instruction on its website to deploy your own project.

Sample `jest` tests that illustrate usage of that library are included in the `serverless-hexagonal-template` project.
* [createItem-MyEntityService.int.js](https://github.com/serverlesspolska/serverless-hexagonal-template/blob/main/__tests__/createItem/iam-createItem-MyEntityService.int.js)
* [processItem-MyEntityService.int.js](https://github.com/serverlesspolska/serverless-hexagonal-template/blob/main/__tests__/processItem/iam-processItem-MyEntityService.int.js).

