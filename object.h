#ifndef OBJECT_H
#define OBJECT_H

#include "pes.h"   // Contains ObjectType, ObjectID, etc.

// Write an object to .pes/objects
// - type: OBJ_BLOB / OBJ_TREE / OBJ_COMMIT
// - data: raw content
// - len: size of data
// - id_out: resulting SHA-256 hash
int object_write(ObjectType type, const void *data, size_t len, ObjectID *id_out);

// Read an object from .pes/objects
// - id: object hash
// - type_out: filled with object type
// - data_out: malloc’d buffer (caller must free)
// - len_out: size of data
int object_read(const ObjectID *id, ObjectType *type_out, void **data_out, size_t *len_out);

#endif // OBJECT_H
