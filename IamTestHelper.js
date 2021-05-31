const AWS = require('aws-sdk')
const log = require('serverless-logger')(__filename)

module.exports = class IamTestHelper {
  constructor(roleName) {
    this.roleName = roleName
    this.iam = new AWS.IAM()
    this.sts = new AWS.STS()
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

    await helper.getCallerIdentity()

    return helper
  }

  async refreshCredentials() {
    const oldSessionTokenKey = (await this.sts.getSessionToken().promise()).Credentials.sessionToken

    const credentials = new AWS.Credentials()
    const get = await credentials.getPromise()
    const refresh = await credentials.refreshPromise()
    log('get', get, 'refresh', refresh)

    const newSessionTokenKey = (await this.sts.getSessionToken().promise()).Credentials.sessionToken
    log('new === old: ', newSessionTokenKey === oldSessionTokenKey);
  }

  async getCallerIdentity() {
    const caller = await this.sts.getCallerIdentity({}).promise()
    this.awsAccountId = caller.Account
    this.principal = caller.Arn
    log(`Caller Identity: your current AWS Account: ${this.awsAccountId}, and Principal: ${this.principal}`)
    return caller
  }

  async getCallerCredentials() {
    const credentials = await this.sts.getSessionToken().promise()
    this.masterCredentials = credentials
    log('Caller credentials has been fetched')
  }

  async getRoleTrustPolicy() {
    const role = await this.iam.getRole({ RoleName: this.roleName }).promise()
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
      await this.iam.updateAssumeRolePolicy(params).promise()
      const sleep = (seconds) => new Promise((resolve) => { setTimeout(resolve, seconds * 1000) })
      log('Waiting 15 seconds so AWS has time to deal with the update');
      await sleep(15) // needed, so AWS figures out trust relationship has been updated
      await this.refreshCredentials()
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
    const params = {
      RoleArn: `arn:aws:iam::${this.awsAccountId}:role/${this.roleName}`,
      RoleSessionName: 'testSession'
    }
    const data = await this.sts.assumeRole(params).promise()

    log(`Assuming AWS Role: ${this.roleName}`);
    const credentials = this.rewriteCredentials(data)
    AWS.config.update(credentials);
  }

  async assumeUserRoleBack() {
    log('Assuming user\'s role back')
    AWS.config.update(this.rewriteCredentials(this.masterCredentials))
  }
}
