import {
  IAMClient, GetRoleCommand, UpdateAssumeRolePolicyCommand
} from '@aws-sdk/client-iam';
import {
  STSClient, AssumeRoleCommand, GetSessionTokenCommand, GetCallerIdentityCommand
} from '@aws-sdk/client-sts';
import { createLogger } from 'serverless-logger';

const log = createLogger(import.meta.url);
const region = 'us-east-1'

export default class IamTestHelper {
  constructor(roleName) {
    this.roleName = roleName;
    this.roleArn = undefined;
    this.credentials = undefined;
    this.isSSO = this.detectSSO();
    this.iam = new IAMClient({ region })
    this.sts = new STSClient({ region })
    // Store original credential state for restoration
    this.originalCredentialState = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      AWS_PROFILE: process.env.AWS_PROFILE
    }
  }

  // eslint-disable-next-line class-methods-use-this
  detectSSO() {
    // Check for SSO-specific environment variables (most reliable)
    if (process.env.AWS_SSO_SESSION_NAME || process.env.AWS_SSO_START_URL) {
      return true;
    }

    // Check if profile name suggests SSO (less reliable, so more specific)
    const profile = process.env.AWS_PROFILE;
    if (profile && (profile.includes('-sso') || profile.endsWith('sso'))) {
      return true;
    }

    return false;
  }

  static async assumeRoleByFullName(roleName) {
    return IamTestHelper.executeRoleAssume(roleName)
  }

  static async assumeRoleByLambdaName(lambdaName) {
    const { stage, region: envRegion, service } = process.env
    if (!stage || !envRegion || !service) {
      throw new Error(`You need to define in Lambda variables: stage(${stage}), region(${envRegion}), service(${service}).`)
    }
    const baseRoleName = `${service}-${stage}-${lambdaName}-${envRegion}`
    let roleName = `${baseRoleName}-lambdaRole`

    if (roleName.length > 64) {
      roleName = baseRoleName
    }
    log(`Lambda Role length: ${roleName.length} : ${roleName}`)
    return IamTestHelper.executeRoleAssume(roleName)
  }

  static async executeRoleAssume(roleName) {
    const helper = new IamTestHelper(roleName)
    await helper.getCallerIdentity()
    await helper.getCallerCredentials()
    await helper.getRoleTrustPolicy()
    await helper.updateRoleTrustPolicy()
    await helper.assumeLambdaRole()

    await helper.getCallerIdentityInRole()

    helper.setCredentialsInEnv()

    return helper
  }

  async refreshCredentials() {
    if (this.isSSO) {
      log('Credential refresh skipped - using SSO profile');
      return;
    }

    try {
      const command = new GetSessionTokenCommand({});
      const response = await this.sts.send(command);
      log('Credentials refreshed for regular AWS profile');
      this.masterCredentials = response;
    } catch (error) {
      log('Failed to refresh credentials:', error.message);
      throw error;
    }
  }

  /**
   *
   * This is just a checkup up method to verify is role was assumed
   */
  async getCallerIdentityInRole() {
    const stsClientInRole = new STSClient({
      region,
      credentials: this.credentials
    });

    const command = new GetCallerIdentityCommand({});
    const response = await stsClientInRole.send(command);

    this.awsAccountId = response.Account
    this.principal = response.Arn
    log(`Caller Identity: your current AWS Account: ${this.awsAccountId}, and Principal: ${this.principal}`)
    return response
  }

  async getCallerIdentity() {
    try {
      const command = new GetCallerIdentityCommand({});
      const response = await this.sts.send(command);
      this.awsAccountId = response.Account
      this.principal = response.Arn

      // Update SSO detection based on actual caller identity
      if (this.principal.includes('AWSReservedSSO_') || this.principal.includes('/sso-session/')) {
        this.isSSO = true;
      }

      log(`Caller Identity: your current AWS Account: ${this.awsAccountId}, and Principal: ${this.principal}`)
      if (this.isSSO) {
        log('SSO profile detected - using SSO-based authentication')
      }
      return response
    } catch (error) {
      if (error.name === 'TokenRefreshRequired') {
        throw new Error('SSO token expired. Please run: aws sso login --profile <your-profile>')
      }
      throw error
    }
  }

  async getCallerCredentials() {
    if (this.isSSO) {
      log('SSO user detected - skipping session token generation')
      this.masterCredentials = null
      return
    }

    try {
      const command = new GetSessionTokenCommand({});
      const credentials = await this.sts.send(command);
      this.masterCredentials = credentials
      log('Caller credentials has been fetched')
    } catch (error) {
      if (error.name === 'AccessDenied' && error.message.includes('GetSessionToken with session credentials')) {
        log('SSO user detected from error - skipping session token generation')
        this.isSSO = true
        this.masterCredentials = null
      } else {
        throw error
      }
    }
  }

  async getRoleTrustPolicy() {
    const command = new GetRoleCommand({ RoleName: this.roleName });
    const role = await this.iam.send(command);
    const trustPolicyJson = decodeURIComponent(role.Role.AssumeRolePolicyDocument)
    const trustPolicy = JSON.parse(trustPolicyJson)
    this.trustPolicy = trustPolicy
    // log(JSON.stringify(trustPolicy))
    log('getRoleTrustPolicy: Lambda role has been fetch and its TrustPolicy was decoded.')
    return trustPolicy
  }

  async updateRoleTrustPolicy() {
    log('updateRoleTrustPolicy: Statement:', JSON.stringify(this.trustPolicy.Statement))
    const awsGroupInRole = this.trustPolicy.Statement[0].Principal.AWS

    const shouldUpdateRole = (section) => {
      log('Principal.AWS section of TrustPolicy contains:', section)
      if (!section) {
        log(`shouldUpdateRole: ${!section} from if #1`)
        return true
      }
      if (Array.isArray(section)) {
        log(`shouldUpdateRole: ${!section.find((e) => e === this.principal)} from if #2`)
        return !section.find((e) => e === this.principal)
      }
      log(`shouldUpdateRole: ${section !== this.principal} from if #3`)
      return section !== this.principal
    }

    if (shouldUpdateRole(awsGroupInRole)) {
      log('Updating Lambda trust relationship policy');
      // eslint-disable-next-line max-len
      this.trustPolicy.Statement[0].Principal.AWS = awsGroupInRole ? [awsGroupInRole, this.principal].flat() : this.principal
      log('New trusted entities in role:', this.trustPolicy.Statement[0].Principal.AWS)
      const params = {
        PolicyDocument: JSON.stringify(this.trustPolicy, null, 2),
        RoleName: this.roleName
      }
      const command = new UpdateAssumeRolePolicyCommand(params);
      await this.iam.send(command);
      const sleep = (seconds) => new Promise((resolve) => { setTimeout(resolve, seconds * 1000) })
      log('Waiting 15 seconds so AWS has time to deal with the update');
      await sleep(15) // needed, so AWS figures out trust relationship has been updated
    }
  }

  // eslint-disable-next-line class-methods-use-this
  rewriteCredentials(data) {
    return ({
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken
    })
  }

  async assumeLambdaRole() {
    const roleArn = `arn:aws:iam::${this.awsAccountId}:role/${this.roleName}`;
    this.roleArn = roleArn;
    const params = {
      RoleArn: roleArn,
      RoleSessionName: 'testSession'
    };

    const command = new AssumeRoleCommand(params);
    const data = await this.sts.send(command);

    log(`Assuming AWS Role: ${this.roleName}`);
    const credentials = this.rewriteCredentials(data);
    // log(JSON.stringify(credentials, null, 2))
    this.credentials = credentials
  }

  setCredentialsInEnv() {
    // For SSO profiles, we need to temporarily unset AWS_PROFILE to avoid credential conflicts
    if (this.isSSO) {
      log('SSO profile detected - temporarily unsetting AWS_PROFILE to use assumed role credentials')
      delete process.env.AWS_PROFILE
    }

    process.env.AWS_ACCESS_KEY_ID = this.credentials.accessKeyId
    process.env.AWS_SECRET_ACCESS_KEY = this.credentials.secretAccessKey
    process.env.AWS_SESSION_TOKEN = this.credentials.sessionToken

    log('Assumed role credentials set in environment variables')
  }

  leaveLambdaRole() {
    IamTestHelper.assumeUserRoleBack.call(this)
  }

  static leaveLambdaRole() {
    this.assumeUserRoleBack()
  }

  async assumeUserRoleBack() {
    log('Restoring original credential state')

    // Clear assumed role credentials
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.AWS_SESSION_TOKEN

    // For SSO profiles, only restore AWS_PROFILE and don't set static credentials
    if (this.isSSO) {
      if (this.originalCredentialState.AWS_PROFILE !== undefined) {
        process.env.AWS_PROFILE = this.originalCredentialState.AWS_PROFILE
        log('SSO profile restored:', this.originalCredentialState.AWS_PROFILE)
      }

      // For SSO profiles, we need to wait for the credential provider to refresh
      log('Waiting for SSO credential provider to refresh...')
      await new Promise((resolve) => {
        setTimeout(resolve, 2000)
      })

      // Test if credentials are working
      try {
        const testSts = new STSClient({ region })
        const identity = await testSts.send(new GetCallerIdentityCommand({}))
        log('SSO credentials verified and ready for use:', identity.Arn)
      } catch (error) {
        log('SSO credentials not immediately available, this is normal for SSO profiles')
        log('Error:', error.message)
        // Wait a bit more for SSO credentials to become available
        await new Promise((resolve) => {
          setTimeout(resolve, 3000)
        })
      }
    } else {
      // For regular profiles, restore all original credentials
      if (this.originalCredentialState.AWS_ACCESS_KEY_ID !== undefined) {
        process.env.AWS_ACCESS_KEY_ID = this.originalCredentialState.AWS_ACCESS_KEY_ID
      }
      if (this.originalCredentialState.AWS_SECRET_ACCESS_KEY !== undefined) {
        process.env.AWS_SECRET_ACCESS_KEY = this.originalCredentialState.AWS_SECRET_ACCESS_KEY
      }
      if (this.originalCredentialState.AWS_SESSION_TOKEN !== undefined) {
        process.env.AWS_SESSION_TOKEN = this.originalCredentialState.AWS_SESSION_TOKEN
      }
      if (this.originalCredentialState.AWS_PROFILE !== undefined) {
        process.env.AWS_PROFILE = this.originalCredentialState.AWS_PROFILE
      }
    }

    log('Original credential state restored')
  }

  static assumeUserRoleBack() {
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.AWS_SESSION_TOKEN
  }

  /**
   * High-level API that automatically handles role assumption and cleanup
   * Use this instead of manually managing beforeAll/afterAll hooks
   *
   * @param {string} lambdaName - Name of the lambda function (e.g., 'createItem')
   * @param {Function} testSuite - Function containing your test cases
   * @param {Object} options - Optional configuration
   * @param {Function} options.cleanup - Optional cleanup function called after role is restored
   */
  static withAssumedRole(lambdaName, testSuite, options = {}) {
    let iamHelper
    const { cleanup } = options

    beforeAll(async () => {
      iamHelper = await IamTestHelper.assumeRoleByLambdaName(lambdaName)
    });

    afterAll(async () => {
      if (iamHelper) {
        // First restore credentials (this handles the waiting internally)
        await iamHelper.assumeUserRoleBack()

        // Run any provided cleanup function with restored credentials
        if (cleanup) {
          await cleanup()
        }
      }
    });

    // Execute the test suite
    testSuite()
  }

  /**
   * Convenience wrapper that combines describe() with role assumption
   *
   * @param {string} description - Test suite description
   * @param {string} lambdaName - Name of the lambda function (e.g., 'createItem')
   * @param {Function} testSuite - Function containing your test cases
   * @param {Object} options - Optional configuration
   */
  static describeWithRole(description, lambdaName, testSuite, options = {}) {
    describe(description, () => {
      IamTestHelper.withAssumedRole(lambdaName, testSuite, options)
    })
  }
}
