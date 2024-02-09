import {
  IAMClient, GetRoleCommand, UpdateAssumeRolePolicyCommand
} from '@aws-sdk/client-iam';
import {
  STSClient, AssumeRoleCommand, GetSessionTokenCommand, GetCallerIdentityCommand
} from '@aws-sdk/client-sts';
import { createLogger } from 'serverless-logger';

const log = createLogger(import.meta.url);
const region = 'us-east-1'

export class IamTestHelper {
  constructor(roleName) {
    this.roleName = roleName;
    this.roleArn = undefined;
    this.credentials = undefined;
    this.iam = new IAMClient({ region })
    this.sts = new STSClient({ region })
  }

  static async assumeRoleByFullName(roleName) {
    return IamTestHelper.executeRoleAssume(roleName)
  }

  static async assumeRoleByLambdaName(lambdaName) {
    const { stage, region, service } = process.env
    if (!stage || !region || !service) {
      throw new Error(`You need to define in Lambda variables: stage(${stage}), region(${region}), service(${service}).`)
    }
    const baseRoleName = `${service}-${stage}-${lambdaName}-${region}`
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

    return helper
  }

  async refreshCredentials() {
    const command = new GetSessionTokenCommand({});
    const response = await this.sts.send(command);
    const oldSessionTokenKey = response.Credentials.sessionToken

    const credentials = new AWS.Credentials()
    const get = await credentials.getPromise()
    const refresh = await credentials.refreshPromise()
    log('get', get, 'refresh', refresh)

    const newSessionTokenKey = (await this.sts.getSessionToken().promise()).Credentials.sessionToken
    log('new === old: ', newSessionTokenKey === oldSessionTokenKey);
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
    const command = new GetCallerIdentityCommand({});
    const response = await this.sts.send(command);
    this.awsAccountId = response.Account
    this.principal = response.Arn
    log(`Caller Identity: your current AWS Account: ${this.awsAccountId}, and Principal: ${this.principal}`)
    return response
  }

  async getCallerCredentials() {
    const command = new GetSessionTokenCommand({});
    const credentials = await this.sts.send(command);
    this.masterCredentials = credentials
    log('Caller credentials has been fetched')
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
      // await this.refreshCredentials() // it was enabled
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

  // eslint-disable-next-line no-dupe-class-members, class-methods-use-this
  rewriteCredentials(data) {
    return {
      accessKeyId: data.Credentials.AccessKeyId,
      secretAccessKey: data.Credentials.SecretAccessKey,
      sessionToken: data.Credentials.SessionToken
    };
  }
}
