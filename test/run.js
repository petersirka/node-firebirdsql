var fb = require('../lib');
var fs = require('fs');
var assert = require('assert');
var Path = require('path');

var config = {
    database: Path.join(process.cwd(), 'test-' + new Date().getTime() + '.fdb'),
    host: '127.0.0.1',     // default
    port: 3050,            // default
    user: 'SYSDBA',        // default
    password: 'masterkey', // default
    role: null,            // default
    pageSize: 4096,        // default when creating database
    timeout: 3000          // default query timeout
}

Array.prototype.async = function(cb) {

    var self = this;
    var item = self.shift();

    if (item === undefined) {
        if (cb)
            cb();
        return;
    }

    item(function() {
        setImmediate(function() {
            self.async(cb);
        });
    });
};

fb.attachOrCreate(config, function (err, db) {

    if (err)
        throw err;

    database = db;

    var task = [];

    task.push(test_create);
    task.push(test_reconnect);
    task.push(test_insert);
    task.push(test_select_insert); // for inserted rows
    task.push(test_update);
    task.push(test_select_update); // for updated rows
    task.push(test_transaction);
    task.push(function(next) {
        db.detach(next);
    });
    task.push(test_pooling);
    task.async();
});

function test_create(next) {

    var name = 'TEST ---> test_create';
    console.time(name);

    // Create table
    database.query('CREATE TABLE test (ID INT, NAME VARCHAR(50), FILE BLOB)', function(err) {
        assert.ok(!err, name + ': create table ' + err);

        // Check if table exists
        database.query('SELECT COUNT(*) FROM test', function(err, r) {
            assert.ok(!err, name + ': check existing of table ' + err);

            assert.ok(r[0].count === 0, name + ': check rows in new table');
            console.timeEnd(name);

            // Next test
            next();
        });
    });
}

function test_reconnect(next) {

    var name = 'TEST ---> test_reconnect';
    console.time(name);
    database.connection._socket.end();
    database.on('reconnect', function() {
        console.timeEnd(name);
        next();
    });
}

function test_insert(next) {

    var name = 'TEST ---> test_insert';
    console.time(name);

    var query = [];

    // Insert record with blob (STREAM)
    query.push(function(next) {
        database.query('INSERT INTO test (ID, NAME, FILE) VALUES(?, ?, ?) RETURNING ID', [1, 'Firebird 1', fs.createReadStream('image.png')], function(err, r) {
            assert.ok(!err, name + ': insert blob (stream) ' + err);
            assert.ok(r['id'] === 1, name + ': blob (stream) returning value');
            next();
        });
    });

    // Insert record with blob (BUFFER)
    query.push(function(next) {
        database.query('INSERT INTO test (ID, NAME, FILE) VALUES(?, ?, ?) RETURNING ID', [2, 'Firebird 2', fs.readFileSync('image.png')], function(err, r) {
            assert.ok(!err, name + ': insert blob (buffer) ' + err);
            assert.ok(r['id'] === 2, name + ': blob (buffer) returning value');
            next();
        });
    });

    // Insert record without blob
    query.push(function(next) {
        database.query('INSERT INTO test (ID, NAME) VALUES(?, ?) RETURNING ID', [3, 'Firebird 3'], function(err, r) {
            assert.ok(!err, name + ': insert without blob (buffer) (1) ' + err);
            assert.ok(r['id'] === 3, name + ': without blob (buffer) returning value');
            next();
        });
    });

    // Insert record without blob (without returning value)
    query.push(function(next) {
        database.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [4, 'Firebird 4'], function(err, r) {
            assert.ok(!err, name + ': insert without blob (buffer) (2) ' + err);
            assert.ok(err === undefined, name + ': insert without blob + without returning value');
            next();
        });
    });

    query.async(function() {
        console.timeEnd(name);
        next();
    });

}

function test_update(next) {

    var name = 'TEST ---> test_update';
    console.time(name);

    var query = [];

    // Insert record with blob (STREAM)
    query.push(function(next) {
        database.query('UPDATE test SET NAME=?, FILE=? WHERE Id=1', ['Firebird 1 (UPD)', fs.createReadStream('image.png')], function(err, r) {
            assert.ok(!err, name + ': update blob (stream) ' + err);
            next();
        });
    });

    // Insert record with blob (BUFFER)
    query.push(function(next) {
        database.query('UPDATE test SET NAME=?, FILE=? WHERE Id=2', ['Firebird 2 (UPD)', fs.readFileSync('image.png')], function(err, r) {
            assert.ok(!err, name + ': update blob (buffer) ' + err);
            next();
        });
    });

    query.async(function() {
        console.timeEnd(name);
        next();
    });

}

function test_select_insert(next) {

    var name = 'TEST ---> test_select_insert';
    console.time(name);

    var query = [];

    // Classic select
    query.push(function(next) {
        database.query('SELECT * FROM test WHERE Id=1', function(err, r) {

            var row = r[0];

            assert.ok(!err, name + ': problem (1) ' + err);
            assert.ok(row !== undefined, name + ': problem (2)');
            assert.ok(row.id === 1 && row.name === 'Firebird 1', name + ': problem with deserializer');
            assert.ok(typeof(row.file) === 'function', name + ': blob');

            row.file(function(err, name, e) {

                assert.ok(!err, name + ': reading blob ' + err);

                var count = 0;

                e.on('data', function(buffer) {
                    count += buffer.length;
                });

                e.on('end', function() {
                    assert.ok(count === 5472, name + ': problem with retrieving blob data');
                    next();
                });
            });
        });
    });

    // Select to array
    query.push(function(next) {
        // Deserialize to array
        database.execute('SELECT COUNT(*), SUM(Id) FROM test', function(err, r) {
            assert.ok(r[0][0] === 4 && r[0][1].low_ === 10, name + ': array deserializer problem');
            next();
        });
    });

    // Sequentially select (object)
    query.push(function(next) {
        var counter = 0;
        database.sequentially('SELECT Id FROM test', function(row, index) {
            counter += row.id;
        }, function() {
            assert.ok(counter === 10, name + ': sequentially (object)');
            next();
        });
    });

    // Sequentially select (array)
    query.push(function(next) {
        var counter = 0;
        database.sequentially('SELECT Id FROM test', function(row, index) {
            counter += row[0];
        }, function() {
            assert.ok(counter === 10, name + ': sequentially (array)');
            next();
        }, true);
    });

    query.async(function() {
        console.timeEnd(name);
        next();
    });
}

function test_select_update(next) {

    var name = 'TEST ---> test_select_update';
    console.time(name);

    var query = [];

    // Classic select 1
    query.push(function(next) {
        database.query('SELECT * FROM test WHERE Id=1', function(err, r) {

            var row = r[0];

            assert.ok(!err, name + ': problem (1) ' + err);
            assert.ok(row !== undefined, name + ': problem (2)');
            assert.ok(row.id === 1 && row.name === 'Firebird 1 (UPD)', name + ': problem with deserializer');
            assert.ok(typeof(row.file) === 'function', name + ': blob');

            row.file(function(err, name, e) {

                assert.ok(!err, name + ': reading blob');

                var count = 0;

                e.on('data', function(buffer) {
                    count += buffer.length;
                });

                e.on('end', function() {
                    assert.ok(count === 5472, name + ': problem with retrieving blob data');
                    next();
                });
            });
        });
    });

    // Classic select 2
    query.push(function(next) {
        database.query('SELECT * FROM test WHERE Id=2', function(err, r) {

            var row = r[0];

            assert.ok(!err, name + ': problem (1) ' + err);
            assert.ok(row !== undefined, name + ': problem (2)');
            assert.ok(row.id === 2 && row.name === 'Firebird 2 (UPD)', name + ': problem with deserializer');
            assert.ok(typeof(row.file) === 'function', name + ': blob');

            row.file(function(err, name, e) {

                assert.ok(!err, name + ': reading blob');

                var count = 0;

                e.on('data', function(buffer) {
                    count += buffer.length;
                });

                e.on('end', function() {
                    assert.ok(count === 5472, name + ': problem with retrieving blob data');
                    next();
                });
            });
        });
    });

    query.async(function() {
        console.timeEnd(name);
        next();
    });
}

function test_transaction(next) {

    var name = 'TEST ---> test_transaction';
    console.time(name);

    var query = [];

    // Invalid transaction
    query.push(function(next) {
        database.transaction(function(err, transaction) {
            transaction.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [5, 'Transaction 1'], function(err) {
                assert.ok(!err, name + ': problem (1) ' + err);
                transaction.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [6, 'Transaction 2'], function(err) {
                assert.ok(!err, name + ': problem (2)');
                    transaction.query('INSERT INTO testa (ID, NAME) VALUES(?, ?)', [7, 'Transaction 3'], function(err) {
                        assert.ok(err, name + ': problem (3)');
                        transaction.rollback(function(err) {
                            assert.ok(!err, name + ': rollback problem');
                            next();
                        });
                    });
                });
            });
        });
    });

    // Select to array
    query.push(function(next) {
        database.query('SELECT COUNT(*) FROM test', function(err, r) {
            assert.ok(r[0].count === 4, name + ': transaction does not work (rollback)');
            next();
        });
    });

    // Valid transaction
    query.push(function(next) {
        database.transaction(function(err, transaction) {
            transaction.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [5, 'Transaction 1'], function(err) {
                assert.ok(!err, name + ': problem (4) ' + err);
                transaction.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [6, 'Transaction 2'], function(err) {
                assert.ok(!err, name + ': problem (5)');
                    transaction.query('INSERT INTO test (ID, NAME) VALUES(?, ?)', [7, 'Transaction 3'], function(err) {
                        assert.ok(!err, name + ': problem (6) ' + err);
                        transaction.commit(function(err) {
                            assert.ok(!err, name + ': commit problem ' + err);
                            next();
                        });
                    });
                });
            });
        });
    });

    // Select to array
    query.push(function(next) {
        database.query('SELECT COUNT(*) FROM test', function(err, r) {
            assert.ok(r[0].count === 7, name + ': transaction does not work (commit)');
            next();
        });
    });

    query.async(function() {
        console.timeEnd(name);
        next();
    });
}

function test_pooling(next) {

    var name = 'TEST ---> test_pooling';
    console.time(name);

    var query = [];
    var pool = fb.pool(2, config);

    query.push(function(next) {
        pool.get(function(err, db) {
            setTimeout(function() {
                // detach a current connection (socket is opened)
                db.detach();
            }, 1000);
            next();
        });
    });

    query.push(function(next) {
        pool.get(function(err, db) {
            setTimeout(function() {
                // detach a current connection (socket is still opened)
                db.detach();
            }, 1500);
            next();
        });
    });

    query.push(function(next) {
        pool.get(function(err, db) {
            next();
        });
        assert.ok(pool.pending.length > 0, name + ': pool pending');
    });

    query.push(function(next) {
        setTimeout(function() {
            pool.detach();
            console.timeEnd(name);
        }, 500);
        next();
    });

    query.async(next);
}