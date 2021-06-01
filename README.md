# serverless-iam-test-helper
Helper that allows easy testing of AWS Lambda IAM roles that were created in Serverless Framework project using `serverless-iam-roles-per-function` plugin.

# How to use?
## 1. Install as a dev dependency
```
npm i -D serverless-iam-test-helper
```
## 2. Make sure there a dedicated role per function
This library works with IAM role naming convention defined by `serverless-iam-roles-per-function` plugin. Make sure you're using it.

## 3. Write test in `jest`

In your `jest` test suite add a `beforeAll` method where you assume the role.
```JavaScript
const IamTestHelper = require('serverless-iam-test-helper')

describe('<LAMBDA_LOGICAL_NAME> Lambda IAM Role', () => {
  beforeAll(async () => {
    await IamTestHelper.assumeRoleByLambdaName('<LAMBDA_LOGICAL_NAME>')
  }); 

  it('should ALLOW <an operation that should be allowed>', async () => {
    // GIVEN
    const payload = { ... }
    const service = new Service()

    // WHEN
    const actual = await service.operation(payload)

    // THEN
    expect(actual).toBe(...)
  })
})
```
The `LAMBDA_LOGICAL_NAME` is the same as defined in the `serverless.yml` in `functions` section. It is crucial to pass correct Lambda name to `assumeRoleByLambdaName()` method.


You may also test that Lambda's IAM Role will block not allowed operations. Here is a sample of such test.

```JavaScript
  it('should DENY dynamodb:Query', async () => {
    // GIVEN
    const payload = {}
    const service = new MyEntityService()

    // WHEN
    let actual
    try {
      await service.getByQuery(payload)
    } catch (exception) {
      actual = exception
    }

    // THEN
    expect(actual.code).toBe('AccessDeniedException')
    expect(actual.message.includes('is not authorized to perform: dynamodb:Query')).toBeTruthy()
  })
```