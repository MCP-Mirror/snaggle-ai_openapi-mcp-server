import { OpenAPIV3 } from 'openapi-types'
import { JSONSchema7 as IJsonSchema } from 'json-schema'

type NewToolMethod = {
  name: string
  description: string
  inputSchema: IJsonSchema & { type: 'object' }
  returnSchema?: IJsonSchema
}

export class OpenAPIToMCPConverter {
  private schemaCache: Record<string, IJsonSchema> = {}
  private resolvingRefs: Set<string> = new Set()

  constructor(private openApiSpec: OpenAPIV3.Document) {}

  /**
   * Resolve a $ref reference to its schema in the openApiSpec.
   * Returns the raw OpenAPI SchemaObject or null if not found.
   */
  private internalResolveRef(ref: string): OpenAPIV3.SchemaObject | null {
    if (!ref.startsWith('#/')) {
      return null
    }
    const parts = ref.replace(/^#\//, '').split('/')
    let current: any = this.openApiSpec
    for (const part of parts) {
      current = current[part]
      if (!current) return null
    }
    return current as OpenAPIV3.SchemaObject
  }

  /**
   * Convert an OpenAPI schema (or reference) into a JSON Schema object.
   * Uses caching and handles cycles by returning $ref nodes.
   */
  convertOpenApiSchemaToJsonSchema(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
  ): IJsonSchema {
    if ('$ref' in schema) {
      const ref = schema.$ref
      // Create base schema with $ref and description if present
      const refSchema: IJsonSchema = { $ref: ref }
      if ('description' in schema && schema.description) {
        refSchema.description = schema.description as string
      }

      // If already cached, return immediately with description
      if (this.schemaCache[ref]) {
        return refSchema
      }

      // If cycling, return ref with description
      if (this.resolvingRefs.has(ref)) {
        return refSchema
      }

      this.resolvingRefs.add(ref)
      const resolved = this.internalResolveRef(ref)
      if (!resolved) {
        this.resolvingRefs.delete(ref)
        return { type: 'object', ...('description' in schema ? { description: schema.description as string } : {}) }
      }

      const converted = this.convertOpenApiSchemaToJsonSchema(resolved)
      this.schemaCache[ref] = converted
      this.resolvingRefs.delete(ref)

      return refSchema
    }

    // Handle inline schema
    const result: IJsonSchema = {}

    if (schema.type) {
      result.type = schema.type as IJsonSchema['type']
    }

    // Convert binary format to uri-reference and enhance description
    if (schema.format === 'binary') {
      result.format = 'uri-reference'
      const binaryDesc = 'absolute paths to local files'
      result.description = schema.description 
        ? `${schema.description} (${binaryDesc})`
        : binaryDesc
    } else {
      if (schema.format) {
        result.format = schema.format
      }
      if (schema.description) {
        result.description = schema.description
      }
    }

    if (schema.enum) {
      result.enum = schema.enum
    }

    if (schema.default !== undefined) {
      result.default = schema.default
    }

    // Handle object properties
    if (schema.type === 'object') {
      result.type = 'object'
      if (schema.properties) {
        result.properties = {}
        for (const [name, propSchema] of Object.entries(schema.properties)) {
          result.properties[name] = this.convertOpenApiSchemaToJsonSchema(propSchema)
        }
      }
      if (schema.required) {
        result.required = schema.required
      }
      if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
        result.additionalProperties = true
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        result.additionalProperties = this.convertOpenApiSchemaToJsonSchema(schema.additionalProperties)
      } else {
        result.additionalProperties = false
      }
    }

    // Handle arrays - ensure binary format conversion happens for array items too
    if (schema.type === 'array' && schema.items) {
      result.type = 'array'
      result.items = this.convertOpenApiSchemaToJsonSchema(schema.items)
    }

    // oneOf, anyOf, allOf
    if (schema.oneOf) {
      result.oneOf = schema.oneOf.map(s => this.convertOpenApiSchemaToJsonSchema(s))
    }
    if (schema.anyOf) {
      result.anyOf = schema.anyOf.map(s => this.convertOpenApiSchemaToJsonSchema(s))
    }
    if (schema.allOf) {
      result.allOf = schema.allOf.map(s => this.convertOpenApiSchemaToJsonSchema(s))
    }

    return result
  }

  convertToMCPTools(): { 
    tools: Record<string, { methods: NewToolMethod[] }>, 
    openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string, path: string }> 
  } {
    const apiName = 'API'

    const openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }> = {}
    const tools: Record<string, { methods: NewToolMethod[] }> = {
      [apiName]: { methods: [] }
    }

    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths || {})) {
      if (!pathItem) continue

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!this.isOperation(method, operation)) continue

        const mcpMethod = this.convertOperationToMCPMethod(operation, method, path)
        if (mcpMethod) {
          tools[apiName].methods.push(mcpMethod)
          openApiLookup[apiName + '-' + mcpMethod.name] = { ...operation, method, path }
        }
      }
    }

    return { tools, openApiLookup }
  }

  private isOperation(
    method: string,
    operation: any
  ): operation is OpenAPIV3.OperationObject {
    return ['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())
  }

  private isParameterObject(
    param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject
  ): param is OpenAPIV3.ParameterObject {
    return !('$ref' in param)
  }

  private isRequestBodyObject(
    body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject
  ): body is OpenAPIV3.RequestBodyObject {
    return !('$ref' in body)
  }

  private resolveParameter(param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject): OpenAPIV3.ParameterObject | null {
    if (this.isParameterObject(param)) {
      return param
    } else {
      const resolved = this.internalResolveRef(param.$ref)
      if (resolved && (resolved as OpenAPIV3.ParameterObject).name) {
        return resolved as OpenAPIV3.ParameterObject
      }
    }
    return null
  }

  private resolveRequestBody(
    body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject
  ): OpenAPIV3.RequestBodyObject | null {
    if (this.isRequestBodyObject(body)) {
      return body
    } else {
      const resolved = this.internalResolveRef(body.$ref)
      if (resolved) {
        return resolved as OpenAPIV3.RequestBodyObject
      }
    }
    return null
  }

  private resolveResponse(
    response: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject
  ): OpenAPIV3.ResponseObject | null {
    if ('$ref' in response) {
      const resolved = this.internalResolveRef(response.$ref)
      if (resolved) {
        return resolved as OpenAPIV3.ResponseObject
      } else {
        return null
      }
    }
    return response
  }

  private convertOperationToMCPMethod(
    operation: OpenAPIV3.OperationObject,
    method: string,
    path: string
  ): NewToolMethod | null {
    if (!operation.operationId) {
      console.warn(`Operation without operationId at ${method} ${path}`)
      return null
    }

    const inputSchema: IJsonSchema & { type: 'object' } = {
      type: 'object',
      properties: {},
      required: []
    }

    // Handle parameters (path, query, header, cookie)
    if (operation.parameters) {
      for (const param of operation.parameters) {
        const paramObj = this.resolveParameter(param)
        if (paramObj && paramObj.schema) {
          const schema = this.convertOpenApiSchemaToJsonSchema(paramObj.schema)
          // Merge parameter-level description if available
          if (paramObj.description) {
            schema.description = paramObj.description
          }
          inputSchema.properties![paramObj.name] = schema
          if (paramObj.required) {
            inputSchema.required!.push(paramObj.name)
          }
        }
      }
    }

    // Handle requestBody
    if (operation.requestBody) {
      const bodyObj = this.resolveRequestBody(operation.requestBody)
      if (bodyObj?.content) {
        // Handle multipart/form-data for file uploads
        // We convert the multipart/form-data schema to a JSON schema and we require
        // that the user passes in a string for each file that points to the local file
        if (bodyObj.content['multipart/form-data']?.schema) {
          const formSchema = this.convertOpenApiSchemaToJsonSchema(bodyObj.content['multipart/form-data'].schema)
          if (formSchema.type === 'object' && formSchema.properties) {
            for (const [name, propSchema] of Object.entries(formSchema.properties)) {
              inputSchema.properties![name] = propSchema
            }
            if (formSchema.required) {
              inputSchema.required!.push(...formSchema.required!)
            }
          }
        }
        // Handle application/json
        else if (bodyObj.content['application/json']?.schema) {
          const bodySchema = this.convertOpenApiSchemaToJsonSchema(bodyObj.content['application/json'].schema)
          // Merge body schema into the inputSchema's properties
          if (bodySchema.type === 'object' && bodySchema.properties) {
            for (const [name, propSchema] of Object.entries(bodySchema.properties)) {
              inputSchema.properties![name] = propSchema
            }
            if (bodySchema.required) {
              inputSchema.required!.push(...bodySchema.required!)
            }
          } else {
            // If the request body is not an object, just put it under "body"
            inputSchema.properties!['body'] = bodySchema
            inputSchema.required!.push('body')
          }
        }
      }
    }

    // Build description including error responses
    let description = operation.summary || operation.description || ''
    if (operation.responses) {
      const errorResponses = Object.entries(operation.responses)
        .filter(([code]) => code.startsWith('4') || code.startsWith('5'))
        .map(([code, response]) => {
          const responseObj = this.resolveResponse(response)
          let errorDesc = responseObj?.description || ''
          return `${code}: ${errorDesc}`
        })

      if (errorResponses.length > 0) {
        description += '\nError Responses:\n' + errorResponses.join('\n')
      }
    }

    // Extract return type (response schema)
    const returnSchema = this.extractResponseType(operation.responses)

    return {
      name: operation.operationId,
      description,
      inputSchema,
      ...(returnSchema ? { returnSchema } : {})
    }
  }

  private extractResponseType(
    responses: OpenAPIV3.ResponsesObject
  ): IJsonSchema | null {
    // Look for a success response
    const successResponse = responses['200'] || responses['201'] || responses['202'] || responses['204']
    if (!successResponse) return null

    const responseObj = this.resolveResponse(successResponse)
    if (!responseObj || !responseObj.content) return null

    if (responseObj.content['application/json']?.schema) {
      const returnSchema = this.convertOpenApiSchemaToJsonSchema(responseObj.content['application/json'].schema)
      
      // Preserve the response description if available and not already set
      if (responseObj.description && !returnSchema.description) {
        returnSchema.description = responseObj.description
      }

      return returnSchema
    }

    // If no JSON response, fallback to a generic string or known formats
    if (responseObj.content['image/png'] || responseObj.content['image/jpeg']) {
      return { type: 'string', format: 'binary', description: responseObj.description || '' }
    }

    // Fallback
    return { type: 'string', description: responseObj.description || '' }
  }
}
